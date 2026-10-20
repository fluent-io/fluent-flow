'use client';

import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { DashboardShell } from './dashboard-shell';

/**
 * Wraps legacy internal surfaces (agents/repos/pipelines). Collaboration-only
 * principals have no legacy org identity; these pages would render empty or
 * restricted data, so they are sent to the board instead. The legacy API
 * routes themselves already deny unscoped access server-side.
 */
export function LegacyAdminGate({ children }: { children: React.ReactNode }) {
  return <DashboardShell><LegacyAccess>{children}</LegacyAccess></DashboardShell>;
}

function LegacyAccess({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();

  const isCollabOnly = status === 'authenticated' && session.user.id === null && !session.user.isSuperadmin;

  useEffect(() => {
    if (isCollabOnly) {
      router.replace('/board');
    }
  }, [isCollabOnly, router]);

  if (isCollabOnly) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Redirecting to your board…</p>
      </div>
    );
  }

  return <>{children}</>;
}
