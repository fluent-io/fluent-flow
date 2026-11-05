'use client';

import { SessionProvider } from 'next-auth/react';
import { MeProvider } from '@/lib/collab/use-me';
import { CurrentProjectProvider } from '@/lib/collab/current-project';
import { AuthGuard } from './auth-guard';
import { TopBar } from './top-bar';
import { Sidebar } from './sidebar';

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <AuthGuard>
        <MeProvider>
          <CurrentProjectProvider>
            <div className="flex h-screen flex-col">
              <TopBar />
              <div className="flex flex-1 overflow-hidden">
                <Sidebar />
                <main className="min-w-0 flex-1 overflow-auto p-4 sm:p-6">{children}</main>
              </div>
            </div>
          </CurrentProjectProvider>
        </MeProvider>
      </AuthGuard>
    </SessionProvider>
  );
}
