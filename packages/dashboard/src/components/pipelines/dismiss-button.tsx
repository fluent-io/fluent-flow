'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface DismissButtonProps {
  repo: string;
  prNumber: number | null;
}

export function DismissButton({ repo, prNumber }: DismissButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  async function handleDismiss() {
    setLoading(true);
    try {
      const body: Record<string, unknown> = { action: 'dismiss-pipeline', repo };
      if (prNumber != null) body.pr_number = prNumber;
      const res = await fetch('/api/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed' }));
        throw new Error(err.error ?? 'Failed to dismiss');
      }
      setDismissed(true);
      router.refresh();
    } catch {
      alert('Failed to dismiss pipeline');
    } finally {
      setLoading(false);
    }
  }

  if (dismissed) {
    return (
      <span className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400">
        Dismissed
      </span>
    );
  }

  return (
    <button
      onClick={handleDismiss}
      disabled={loading}
      className="rounded-md border border-red-800 bg-red-950 px-3 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-900 disabled:opacity-50"
    >
      {loading ? 'Dismissing…' : 'Dismiss'}
    </button>
  );
}
