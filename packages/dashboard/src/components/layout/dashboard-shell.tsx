'use client';

import { SessionProvider } from 'next-auth/react';
import { AuthGuard } from './auth-guard';
import { TopBar } from './top-bar';
import { Sidebar } from './sidebar';

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <AuthGuard>
        <div className="flex h-screen flex-col">
          <TopBar />
          <div className="flex flex-1 overflow-hidden">
            <Sidebar />
            <main className="flex-1 overflow-auto p-6">{children}</main>
          </div>
        </div>
      </AuthGuard>
    </SessionProvider>
  );
}
