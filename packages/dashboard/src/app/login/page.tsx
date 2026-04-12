'use client';

import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Fluent Flow</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to manage your AI agents
          </p>
        </div>
        <Button onClick={() => signIn('github', { callbackUrl: '/agents' })} className="w-full">
          Sign in with GitHub
        </Button>
      </div>
    </div>
  );
}
