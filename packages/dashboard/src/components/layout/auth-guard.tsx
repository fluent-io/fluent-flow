'use client';

import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

const GITHUB_APP_SLUG = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG ?? 'fluent-flow-ci';
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

  if (session.user.orgs.length === 0 && !session.user.isSuperadmin) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="mx-auto flex max-w-md flex-col items-center gap-4 text-center">
          <h2 className="text-lg font-semibold">Get started with Fluent Flow</h2>
          <p className="text-sm text-muted-foreground">
            Install the Fluent Flow GitHub App on an organization or your personal account to connect your repos.
          </p>
          <Button asChild>
            <a href={INSTALL_URL}>Install on GitHub</a>
          </Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
