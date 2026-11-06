import { createHash } from 'node:crypto';
import type { NextAuthOptions, Session } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import GitHubProvider from 'next-auth/providers/github';
import CredentialsProvider from 'next-auth/providers/credentials';
import {
  upsertUser,
  getUserOrgs,
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
      await upsertUser({
        github_id: ghProfile.id,
        login: ghProfile.login,
        email: user.email ?? null,
        avatar_url: ghProfile.avatar_url ?? null,
      });
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
          legacyUserId: userResult.rows[0].id,
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
            legacyUserId: userResult.rows[0].id,
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

      if (principal.legacyUserId !== null) {
        const userResult = await query(
          'SELECT id, github_id, login, email, avatar_url, is_superadmin FROM users WHERE id = $1',
          [principal.legacyUserId],
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
