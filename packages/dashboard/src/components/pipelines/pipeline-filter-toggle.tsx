'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

const filters = [
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'All' },
] as const;

export function PipelineFilterToggle() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = (searchParams.get('filter') ?? 'active') as string;

  const setFilter = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'active') {
        params.delete('filter');
      } else {
        params.set('filter', value);
      }
      router.push(`/pipelines?${params.toString()}`);
    },
    [router, searchParams],
  );

  return (
    <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
      {filters.map((f) => (
        <button
          key={f.value}
          onClick={() => setFilter(f.value)}
          className={`rounded px-2.5 py-1 text-xs transition-colors ${
            current === f.value
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}
