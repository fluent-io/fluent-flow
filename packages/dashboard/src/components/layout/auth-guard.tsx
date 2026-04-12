'use client';

import { useSession } from 'next-auth/react';
import { redirect } from 'next/navigation';

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!session) {
    redirect('/login');
  }

  if (session.user.orgs.length === 0 && !session.user.isSuperadmin) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h2 className="text-lg font-semibold">No Access</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            You don&apos;t have access to any organization. Contact a superadmin to get access.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
