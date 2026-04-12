import type { NextAuthOptions, Session } from 'next-auth';
import GitHubProvider from 'next-auth/providers/github';
import { upsertUser, getUserOrgs } from '@fluent-flow/db';
import type { UserOrg } from '@fluent-flow/db';

declare module 'next-auth' {
  interface Session {
    user: {
      id: number;
      login: string;
      email?: string | null;
      image?: string | null;
      isSuperadmin: boolean;
      orgs: UserOrg[];
    };
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ user, profile }) {
      const ghProfile = profile as { id: number; login: string; avatar_url?: string };
      await upsertUser({
        github_id: ghProfile.id,
        login: ghProfile.login,
        email: user.email ?? null,
        avatar_url: ghProfile.avatar_url ?? null,
      });
      return true;
    },
    async jwt({ token, profile }) {
      if (profile) {
        const ghProfile = profile as { id: number; login: string };
        token.github_id = ghProfile.id;
        token.login = ghProfile.login;
      }
      return token;
    },
    async session({ session, token }) {
      const { query } = await import('@fluent-flow/db');
      const userResult = await query(
        'SELECT id, is_superadmin FROM users WHERE github_id = $1',
        [token.github_id as number],
      );

      if (userResult.rows.length === 0) {
        throw new Error('User not found');
      }

      const dbUser = userResult.rows[0];
      const orgs = await getUserOrgs(dbUser.id);

      session.user = {
        id: dbUser.id,
        login: token.login as string,
        email: token.email,
        image: token.picture,
        isSuperadmin: dbUser.is_superadmin,
        orgs,
      };
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
