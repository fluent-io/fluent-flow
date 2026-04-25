'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/** Dashboard labels that map to runner claim types in the API */
const CLAIM_TYPES = [
  { value: 'review', label: 'Review' },
  { value: 'build', label: 'Build' },
  { value: 'fix', label: 'Fix' },
  { value: 'test', label: 'Test' },
] as const;
type ClaimType = typeof CLAIM_TYPES[number]['value'];

export function StartWorkflowDialog({ repoId, repoFullName }: { repoId: string; repoFullName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [claimType, setClaimType] = useState<ClaimType>('review');
  const [description, setDescription] = useState('');
  const [prNumber, setPrNumber] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setClaimType('review');
    setDescription('');
    setPrNumber('');
    setError(null);
    setSubmitting(false);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const pr = Number(prNumber);
      if (!prNumber || !Number.isInteger(pr) || pr < 1) {
        throw new Error('PR number is required and must be a positive integer');
      }

      const body: Record<string, unknown> = {
        claim_type: claimType,
        description: description.trim() || `Run ${claimType} on ${repoFullName} PR #${pr}`,
        pr_number: pr,
      };

      const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/claims`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
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

  const canSubmit = prNumber && Number.isInteger(Number(prNumber)) && Number(prNumber) > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm">Start workflow</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Start workflow — {repoFullName}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Type
            <select
              className="rounded border bg-background px-2 py-1"
              value={claimType}
              onChange={(e) => setClaimType(e.target.value as ClaimType)}
            >
              {CLAIM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            PR number <span className="text-xs text-muted-foreground">(required)</span>
            <input
              className="rounded border bg-background px-2 py-1"
              type="number"
              min={1}
              step={1}
              value={prNumber}
              onChange={(e) => setPrNumber(e.target.value)}
              placeholder="123"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Description
            <textarea
              className="rounded border bg-background px-2 py-1 text-sm"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={claimType === 'review' ? 'Specific review focus' : 'What should the agent do?'}
            />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={submitting || !canSubmit}>
              {submitting ? 'Starting…' : 'Start'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
