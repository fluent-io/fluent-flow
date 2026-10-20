'use client';

import { Suspense, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const GENERIC_SIGNIN_ERROR = 'Sign-in failed. Check your details and try again.';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') ?? '/board';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await signIn('credentials', { email, password, redirect: false });
      if (!result || result.error) {
        setError(GENERIC_SIGNIN_ERROR);
        return;
      }
      router.replace(callbackUrl);
      router.refresh();
    } catch {
      setError(GENERIC_SIGNIN_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Fluent Flow</h1>
        <p className="mt-2 text-sm text-muted-foreground">Sign in to your collaboration workspace</p>
      </div>

      {error ? (
        <p role="alert" className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <form onSubmit={submit} className="flex w-full flex-col gap-3">
        <Input
          type="email"
          name="email"
          autoComplete="email"
          placeholder="Email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <div className="flex w-full items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <Button variant="outline" onClick={() => signIn('github', { callbackUrl })} className="w-full">
        Sign in with GitHub
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        Working from an invitation? Open the invitation link you received.
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
