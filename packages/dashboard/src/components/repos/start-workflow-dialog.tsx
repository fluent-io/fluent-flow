'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export function StartWorkflowDialog({ repoId, repoFullName }: { repoId: string; repoFullName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setDescription('');
    setError(null);
    setSubmitting(false);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/claims`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          claim_type: 'spec',
          description: description.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `Request failed with ${res.status}`);
      }
      reset();
      setOpen(false);
      router.push('/pipelines');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm">Start workflow</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Start spec workflow — {repoFullName}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Start workflow creates a Spec claim. Feature, fix, review, and verification work are pipeline steps that happen after a workflow is planned.
          </p>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Spec prompt</label>
            <textarea
              className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
              rows={8}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe your idea — we'll break it into an implementation plan..."
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting ? 'Starting…' : 'Start spec'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
