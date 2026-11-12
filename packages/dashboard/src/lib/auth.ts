import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { NextAuthOptions, Session } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import GitHubProvider from 'next-auth/providers/github';
import CredentialsProvider from 'next-auth/providers/credentials';
import {
  upsertUser,
  getUserOrgs,
  linkUserToOrgIfProvisioned,
  ensureDefaultWorkspace,
  enrollOrgAdminInDefaultWorkspaces,
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

const githubInstallationSchema = z.object({
  account: z
    .object({
      login: z.string().min(1),
    })
    .nullable()
    .optional(),
});

const githubInstallationsResponseSchema = z.object({
  total_count: z.number().optional(),
  installations: z.array(githubInstallationSchema),
});

const INSTALLATIONS_PAGE_SIZE = 100;
const INSTALLATIONS_MAX_PAGES = 10; // 1000 installations — far beyond any real org's app installs
const INSTALLATIONS_FETCH_TIMEOUT_MS = 8000;

async function fetchGithubInstallationOrgIds(accessToken: string): Promise<string[]> {
  const orgIds: string[] = [];
  for (let page = 1; page <= INSTALLATIONS_MAX_PAGES; page++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INSTALLATIONS_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(
        `https://api.github.com/user/installations?per_page=${INSTALLATIONS_PAGE_SIZE}&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'fluent-flow-dashboard',
          },
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      console.error('reconcileGithubOrgAccess: GitHub API error', { status: res.status, page });
      break;
    }
    const parsed = githubInstallationsResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.error('reconcileGithubOrgAccess: unexpected GitHub API response shape', {
        page,
        error: parsed.error.message,
      });
      break;
    }
    for (const installation of parsed.data.installations) {
      const login = installation.account?.login;
      if (login) orgIds.push(login);
    }
    if (parsed.data.installations.length < INSTALLATIONS_PAGE_SIZE) break;
  }
  return orgIds;
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
 * Links as `member`, not `admin`: GitHub's `/user/installations` lists every
 * installation the signed-in user can merely *see* (any org member with
 * access to a covered repo), not just the one they personally installed —
 * granting admin from that signal would be a privilege escalation, not a
 * repair. Restoring a specific installer's admin role (if their webhook
 * link failed) is out of scope here and needs a separate, stronger signal
 * (e.g. GitHub's org-membership-role API) than this endpoint provides.
 *
 * Deliberately best-effort: never blocks or fails sign-in. Every failure
 * path here is caught and logged, not rethrown, because org-access repair is
 * a convenience on top of a successful authentication, not a prerequisite
 * for it.
 *
 * Linking is atomic per org via `linkUserToOrgIfProvisioned`: it only
 * inserts when the org is already provisioned and the user has no existing
 * link, in one statement, so there's no read-then-write race and an
 * existing link (at any role) is never touched — never downgraded, never
 * escalated.
 */
async function reconcileGithubOrgAccess(userId: number, accessToken: string | undefined): Promise<void> {
  if (!accessToken) return;

  let orgIds: string[];
  try {
    orgIds = await fetchGithubInstallationOrgIds(accessToken);
  } catch (err) {
    console.error('reconcileGithubOrgAccess: failed to fetch installations', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  for (const orgId of orgIds) {
    try {
      await linkUserToOrgIfProvisioned(userId, orgId, 'member');
    } catch (err) {
      console.error('reconcileGithubOrgAccess: failed to link org', {
        orgId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await ensureDefaultWorkspace(orgId, { createdByPrincipalId: null });
    } catch (err) {
      console.error('reconcileGithubOrgAccess: failed to ensure default workspace', {
        safeToContinue: 'Authentication succeeded; future sign-ins retry workspace creation',
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
        try {
          await enrollOrgAdminInDefaultWorkspaces(principal.id);
        } catch (err) {
          console.error('jwt: failed to enroll org admin in default workspaces', {
            safeToContinue: 'Authentication succeeded; future sign-ins retry enrollment',
            principalId: principal.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
