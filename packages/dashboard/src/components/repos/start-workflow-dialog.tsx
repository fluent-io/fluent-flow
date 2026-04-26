'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const WORKFLOW_TYPES = [
  { value: 'feature', emoji: '✨', label: 'Feature', description: 'Build something new' },
  { value: 'fix', emoji: '🔧', label: 'Fix', description: 'Fix a bug or issue' },
  { value: 'review', emoji: '🔍', label: 'Review', description: 'Review a PR' },
  { value: 'spec', emoji: '📋', label: 'Spec', description: 'Break idea into plan' },
] as const;
type WorkflowType = (typeof WORKFLOW_TYPES)[number]['value'];

const PR_REQUIRED_TYPES = new Set<WorkflowType>(['fix', 'review']);

const PLACEHOLDERS: Record<WorkflowType, string> = {
  feature: 'Describe what you want built...',
  fix: 'What needs to be fixed?',
  review: 'Any specific review focus?',
  spec: 'Describe your idea — we\'ll break it into an implementation plan...',
};

export function StartWorkflowDialog({ repoId, repoFullName }: { repoId: string; repoFullName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [workflowType, setWorkflowType] = useState<WorkflowType>('feature');
  const [description, setDescription] = useState('');
  const [prNumber, setPrNumber] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setWorkflowType('feature');
    setDescription('');
    setPrNumber('');
    setError(null);
    setSubmitting(false);
  }

  const needsPr = PR_REQUIRED_TYPES.has(workflowType);
  const canSubmit = needsPr
    ? prNumber && Number.isInteger(Number(prNumber)) && Number(prNumber) > 0
    : true;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      if (needsPr) {
        const pr = Number(prNumber);
        if (!prNumber || !Number.isInteger(pr) || pr < 1) {
          throw new Error('PR number is required and must be a positive integer');
        }
      }

      const body: Record<string, unknown> = {
        claim_type: workflowType,
        description: description.trim() || undefined,
      };

      if (needsPr) {
        body.pr_number = Number(prNumber);
      }

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

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm">Start workflow</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Start workflow — {repoFullName}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {/* Type selector: horizontal button group */}
          <div>
            <label className="mb-2 block text-sm font-medium">Type</label>
            <div className="grid grid-cols-4 gap-2">
              {WORKFLOW_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => {
                    setWorkflowType(t.value);
                    if (!PR_REQUIRED_TYPES.has(t.value)) {
                      setPrNumber('');
                    }
                  }}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-center transition-colors',
                    workflowType === t.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background text-muted-foreground hover:border-muted-foreground/40 hover:bg-muted/50',
                  )}
                >
                  <span className="text-lg">{t.emoji}</span>
                  <span className="text-xs font-medium">{t.label}</span>
                  <span className="text-[10px] leading-tight opacity-70">{t.description}</span>
                </button>
              ))}
            </div>
          </div>

          {/* PR number — only for fix/review */}
          {needsPr && (
            <div>
              <label className="mb-1.5 block text-sm font-medium">
                PR number <span className="text-xs text-muted-foreground">(required)</span>
              </label>
              <Input
                type="number"
                min={1}
                step={1}
                value={prNumber}
                onChange={(e) => setPrNumber(e.target.value)}
                placeholder="123"
              />
            </div>
          )}

          {/* Description textarea */}
          <div>
            <label className="mb-1.5 block text-sm font-medium">Prompt</label>
            <textarea
              className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
              rows={8}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={PLACEHOLDERS[workflowType]}
            />
          </div>

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
