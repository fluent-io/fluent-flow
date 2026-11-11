import { createHash } from 'node:crypto';
import type { NextAuthOptions, Session } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import GitHubProvider from 'next-auth/providers/github';
import CredentialsProvider from 'next-auth/providers/credentials';
import {
  upsertUser,
  getUserOrgs,
  linkUserToOrg,
  query,
  authenticateCollabPassword,
  ensureGithubPrincipal,
  getCollabPrincipal,
} from '@fluent-flow/db';
import type { UserOrg } from '@fluent-flow/db';

declare module 'next-auth' {
  interface Session {
    user: {
      id: number | null;
      principalId: string;
      sessionVersion: number;
      login: string;
      email?: string | null;
      image?: string | null;
      isSuperadmin: boolean;
      orgs: UserOrg[];
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    github_id?: number;
    login?: string;
    principalId?: string;
    sessionVersion?: number;
  }
}

interface AuthorizeUser {
  id: string;
  principalId: string;
  sessionVersion: number;
  login: string;
  email: string | null;
}

function rateLimitKeyFrom(req: { headers?: Record<string, unknown> } | undefined): string {
  const trustedHeader = process.env.FF_TRUSTED_PROXY_CLIENT_HEADER?.toLowerCase();
  if (trustedHeader) {
    const value = req?.headers?.[trustedHeader];
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string' && first.length > 0) {
      return createHash('sha256').update(first.split(',')[0].trim()).digest('hex');
    }
  }
  return createHash('sha256').update('unproxied').digest('hex');
}

/**
 * Self-heals org membership on every GitHub sign-in against GitHub's own
 * installation records, rather than relying solely on the one-shot
 * `installation.created` webhook (handleInstallationCreated links the
 * installer as org admin, but that link attempt is wrapped in a try/catch
 * that only logs on failure — see installation-lifecycle.js). If that
 * webhook was missed, mis-attributed, or errored, this recovers the link the
 * next time the affected user signs in, without requiring any manual fix.
 *
 * Deliberately best-effort: never blocks or fails sign-in. Every failure
 * path here is caught and logged, not rethrown, because org-access repair is
 * a convenience on top of a successful authentication, not a prerequisite
 * for it. An org that doesn't exist yet means the install webhook itself
 * never ran (a larger gap than this function can repair) — logged and
 * skipped rather than attempted, since linking to an unknown org would
 * violate the FK and is out of scope for a per-sign-in reconciliation.
 */
async function reconcileGithubOrgAccess(userId: number, accessToken: string | undefined): Promise<void> {
  if (!accessToken) return;

  let installations: Array<{ account?: { login?: string | null } | null }>;
  try {
    const res = await fetch('https://api.github.com/user/installations', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'fluent-flow-dashboard',
      },
    });
    if (!res.ok) {
      console.error('reconcileGithubOrgAccess: GitHub API error', { status: res.status });
      return;
    }
    const body = (await res.json()) as { installations?: unknown };
    installations = Array.isArray(body.installations) ? (body.installations as typeof installations) : [];
  } catch (err) {
    console.error('reconcileGithubOrgAccess: failed to fetch installations', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const existingOrgIds = new Set((await getUserOrgs(userId)).map((o) => o.org_id));

  for (const installation of installations) {
    const orgId = installation?.account?.login;
    if (!orgId || existingOrgIds.has(orgId)) continue;
    try {
      const orgRow = await query('SELECT 1 FROM orgs WHERE id = $1', [orgId]);
      if (orgRow.rows.length === 0) {
        console.error('reconcileGithubOrgAccess: org not provisioned, skipping link', { orgId });
        continue;
      }
      await linkUserToOrg(userId, orgId, 'admin');
    } catch (err) {
      console.error('reconcileGithubOrgAccess: failed to link org', {
        orgId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
    CredentialsProvider({
      name: 'Email and password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, req): Promise<AuthorizeUser | null> {
        if (!credentials?.email || !credentials?.password) return null;
        const principal = await authenticateCollabPassword({
          email: credentials.email,
          password: credentials.password,
          rateLimitKey: rateLimitKeyFrom(req),
        });
        if (!principal) return null;
        return {
          id: principal.id,
          principalId: principal.id,
          sessionVersion: principal.sessionVersion,
          login: principal.displayName,
          email: principal.email,
        };
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider !== 'github' || !profile) return true;
      const ghProfile = profile as { id: number; login: string; avatar_url?: string };
      const dbUser = await upsertUser({
        github_id: ghProfile.id,
        login: ghProfile.login,
        email: user.email ?? null,
        avatar_url: ghProfile.avatar_url ?? null,
      });
      await reconcileGithubOrgAccess(dbUser.id, account.access_token);
      return true;
    },
    async jwt({ token, user, profile }) {
      if (profile) {
        const ghProfile = profile as { id: number; login: string };
        token.github_id = ghProfile.id;
        token.login = ghProfile.login;

        const userResult = await query('SELECT id FROM users WHERE github_id = $1', [ghProfile.id]);
        if (userResult.rows.length === 0) {
          throw new Error('User not found');
        }
        const principal = await ensureGithubPrincipal({
          userId: userResult.rows[0].id,
          displayName: ghProfile.login,
          email: user.email ?? null,
        });
        token.principalId = principal.id;
        token.sessionVersion = principal.sessionVersion;
      }
      if (user) {
        const authorized = user as Partial<AuthorizeUser>;
        if (authorized.principalId) {
          token.principalId = authorized.principalId;
          token.sessionVersion = authorized.sessionVersion;
          token.login = authorized.login;
          token.email = authorized.email ?? null;
        }
      }
      if (!token.principalId && token.github_id) {
        const userResult = await query('SELECT id FROM users WHERE github_id = $1', [token.github_id]);
        if (userResult.rows.length > 0) {
          const principal = await ensureGithubPrincipal({
            userId: userResult.rows[0].id,
            displayName: (token.login as string) ?? '',
            email: (token.email as string | null) ?? null,
          });
          token.principalId = principal.id;
          token.sessionVersion = principal.sessionVersion;
        }
      }
      return token;
    },
    async session({ session, token }) {
      const principalId = token.principalId;
      if (!principalId) {
        throw new Error('No collaboration principal on session token');
      }
      const principal = await getCollabPrincipal(principalId);
      if (!principal || principal.disabledAt || principal.sessionVersion !== token.sessionVersion) {
        throw new Error('Session rejected');
      }

      if (principal.userId !== null) {
        const userResult = await query(
          'SELECT id, github_id, login, email, avatar_url, is_superadmin FROM users WHERE id = $1',
          [principal.userId],
        );
        const dbUser = userResult.rows[0];
        if (!dbUser || (token.github_id !== undefined && token.github_id !== dbUser.github_id)) {
          throw new Error('Session rejected');
        }
        const orgs = await getUserOrgs(dbUser.id);
        session.user = {
          id: dbUser.id,
          principalId: principal.id,
          sessionVersion: principal.sessionVersion,
          login: dbUser.login,
          email: dbUser.email ?? null,
          image: dbUser.avatar_url ?? null,
          isSuperadmin: dbUser.is_superadmin,
          orgs,
        };
      } else {
        if (token.github_id !== undefined) {
          throw new Error('Session rejected');
        }
        session.user = {
          id: null,
          principalId: principal.id,
          sessionVersion: principal.sessionVersion,
          login: principal.displayName,
          email: principal.email,
          image: null,
          isSuperadmin: false,
          orgs: [],
        };
      }
      return session;
    },
  },
  pages: {
    signIn: '/login',
  },
};

export function getOrgScope(session: Session): { orgIds: string[]; isSuperadmin: boolean } {
  if (session.user.isSuperadmin) {
    return { orgIds: [], isSuperadmin: true };
  }
  return { orgIds: session.user.orgs.map((o) => o.org_id), isSuperadmin: false };
}

export function hasRole(session: Session, orgId: string, minRole: 'member' | 'admin'): boolean {
  if (session.user.isSuperadmin) return true;
  const org = session.user.orgs.find((o) => o.org_id === orgId);
  if (!org) return false;
  if (minRole === 'member') return true;
  return org.role === 'admin';
}
