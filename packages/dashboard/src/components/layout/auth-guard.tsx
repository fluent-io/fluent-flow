'use client';

import { useEffect } from 'react';
import { signOut, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

const GITHUB_APP_SLUG = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG ?? 'fluent-flow';
const INSTALL_URL = `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`;

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login');
    }
  }, [status, router]);

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!session) {
    return null;
  }

  const isGithubUser = session.user.id !== null || session.user.isSuperadmin;
  if (isGithubUser && session.user.orgs.length === 0 && !session.user.isSuperadmin) {
    const preview = session.githubApp?.preview === true;
    const installUrl = session.githubApp?.installUrl ?? INSTALL_URL;
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="mx-auto flex max-w-md flex-col items-center gap-4 text-center">
          <h2 className="text-lg font-semibold">Get started with Fluent Flow</h2>
          <p className="text-sm text-muted-foreground">
            {preview
              ? 'This preview is separate from your production installation. Connect only the Preview App to a controlled test repository.'
              : 'Install the Fluent Flow GitHub App on an organization or your personal account to connect your repos.'}
          </p>
          {preview ? (
            <p className="text-sm text-muted-foreground">
              Already installed the Preview App? Ask an administrator to replay its installation event, then sign out and sign in again. You do not need to uninstall or reinstall it.
            </p>
          ) : null}
          <Button asChild>
            <a href={installUrl}>{preview ? 'Open Preview App on GitHub' : 'Install on GitHub'}</a>
          </Button>
          <Button variant="outline" onClick={() => void signOut({ callbackUrl: '/login' })}>Sign out</Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
