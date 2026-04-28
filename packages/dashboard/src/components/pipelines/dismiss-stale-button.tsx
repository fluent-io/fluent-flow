'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface DismissStaleButtonProps {
  olderThanMs?: number;
}

export function DismissStaleButton({ olderThanMs }: DismissStaleButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ dismissed: number } | null>(null);

  async function handleDismissStale() {
    if (!confirm('Dismiss all stale claims (pending/claimed for over 24h)?')) return;
    setLoading(true);
    setResult(null);
    try {
      const body: Record<string, unknown> = { action: 'dismiss-stale' };
      if (olderThanMs != null) body.older_than_ms = olderThanMs;
      const res = await fetch('/api/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed' }));
        throw new Error(err.error ?? 'Failed to dismiss stale claims');
      }
      const data = await res.json();
      setResult(data);
      router.refresh();
    } catch {
      alert('Failed to dismiss stale claims');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleDismissStale}
        disabled={loading}
        className="rounded-md border border-red-800 bg-red-950 px-3 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-900 disabled:opacity-50"
      >
        {loading ? 'Dismissing…' : 'Dismiss Stale'}
      </button>
      {result && (
        <span className="text-xs text-muted-foreground">
          {result.dismissed} claim{result.dismissed === 1 ? '' : 's'} dismissed
        </span>
      )}
    </div>
  );
}
