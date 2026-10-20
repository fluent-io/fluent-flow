'use client';

import { useEffect, useState } from 'react';
import { signIn, SessionProvider, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, collabFetch } from '@/lib/collab/api';
import type { Principal } from '@/lib/collab/types';

const INVALID_INVITE = 'This invitation is invalid or no longer available.';
const RATE_LIMITED = 'Too many attempts. Please wait a moment and try again.';

/**
 * Invitation redemption. The one-time secret travels in the URL fragment only:
 * fragments never reach server access logs, referrers or the proxy. It is read
 * client-side, sent once in the request body, and cleared immediately after.
 */
function extractInviteToken(): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith('#')) return null;
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get('token');
  return token && token.length > 0 ? token : null;
}

export default function InvitePage() {
  return (
    <SessionProvider>
      <InviteRedemption />
    </SessionProvider>
  );
}

function InviteRedemption() {
  const router = useRouter();
  const { data: session, status } = useSession();

  const [token, setToken] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<'none' | 'redeemed' | 'needs-signin'>('none');

  useEffect(() => {
    setToken(extractInviteToken());
  }, []);

  useEffect(() => {
    if (outcome === 'redeemed') {
      history.replaceState(null, '', '/invite');
      router.replace('/board');
    }
  }, [outcome, router]);

  async function accept() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const authenticated = status === 'authenticated';
      const body: Record<string, string> = {
        token,
        // A's accept schema requires a non-empty display name; authenticated
        // acceptance keeps the current principal's name.
        displayName: authenticated ? (session?.user?.login ?? '') : displayName,
      };
      if (!authenticated) {
        if (password.length === 0) {
          setError('Choose a password to finish setting up your account.');
          return;
        }
        body.password = password;
      }
      const result = await collabFetch<{ principal: Principal }>('/invitations/accept', {
        method: 'POST',
        body,
      });

      // Clear the secret from the URL before anything else.
      history.replaceState(null, '', '/invite');

      if (authenticated) {
        router.replace('/board');
        return;
      }

      // New principal: sign in with the invitation email and chosen password.
      const email = result.data.principal.email;
      if (!email) {
        setToken(null);
        setOutcome('needs-signin');
        return;
      }
      const login = await signIn('credentials', { email, password, redirect: false });
      if (!login || login.error) {
        setToken(null);
        setOutcome('needs-signin');
        return;
      }
      setOutcome('redeemed');
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError(RATE_LIMITED);
      } else if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        setError(INVALID_INVITE);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (outcome === 'needs-signin') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-4 text-center">
          <h1 className="text-xl font-semibold">Workspace joined</h1>
          <p className="text-sm text-muted-foreground">
            Your account is ready. Sign in with your email and the password you chose.
          </p>
          <Button onClick={() => router.replace('/login')}>Go to sign in</Button>
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-4 text-center">
          <h1 className="text-xl font-semibold">Invitation</h1>
          <p role="alert" className="text-sm text-muted-foreground">
            {INVALID_INVITE}
          </p>
          <Button variant="outline" onClick={() => router.replace('/login')}>
            Go to sign in
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void accept();
        }}
        className="mx-auto flex w-full max-w-sm flex-col gap-4"
      >
        <div className="text-center">
          <h1 className="text-xl font-semibold">Join your workspace</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {status === 'authenticated'
              ? `Accept this invitation as ${session?.user?.login ?? 'your account'}?`
              : 'Finish setting up your account to join the workspace.'}
          </p>
        </div>

        {error ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {status !== 'authenticated' ? (
          <>
            <Input
              placeholder="Your name"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <Input
              type="password"
              placeholder="Choose a password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        ) : null}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Accepting…' : 'Accept invitation'}
        </Button>
      </form>
    </div>
  );
}
