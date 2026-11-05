'use client';

import { useSession, signOut } from 'next-auth/react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ProjectSelector } from './project-selector';

export function TopBar() {
  const { data: session } = useSession();
  const user = session?.user;
  const orgId = user?.orgs[0]?.org_id ?? null;

  return (
    <header className="flex h-12 items-center justify-between gap-2 border-b border-border bg-card px-3 sm:px-5">
      <div className="shrink-0 text-sm font-bold tracking-tight">Fluent Flow</div>
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <ProjectSelector />
        {orgId ? (
          <span className="hidden rounded border border-border bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground md:inline">
            {orgId}
          </span>
        ) : null}
        <div className="flex items-center gap-2">
          <Avatar className="h-7 w-7">
            <AvatarImage src={user?.image ?? undefined} />
            <AvatarFallback className="text-xs">
              {user?.login?.charAt(0).toUpperCase() ?? '?'}
            </AvatarFallback>
          </Avatar>
          <span className="hidden text-xs text-muted-foreground md:inline">{user?.login}</span>
        </div>
        <Button variant="ghost" size="sm" className="shrink-0" onClick={() => signOut({ callbackUrl: '/login' })}>
          Sign out
        </Button>
      </div>
    </header>
  );
}
