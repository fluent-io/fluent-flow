'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Step = 1 | 2 | 3;
type AgentType = 'claude-code' | 'codex' | 'devin' | 'openclaw' | 'aider' | 'custom';

const AGENT_TYPES: AgentType[] = ['claude-code', 'codex', 'devin', 'openclaw', 'aider', 'custom'];

export function NewAgentDialog() {
  const { data: session } = useSession();
  const router = useRouter();
  const adminOrgs = (session?.user?.orgs ?? []).filter((o) => o.role === 'admin');
  const canCreate = adminOrgs.length > 0 || session?.user?.isSuperadmin;

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>(1);
  const [orgId, setOrgId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [agentType, setAgentType] = useState<AgentType>('claude-code');
  const [submitting, setSubmitting] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Default org to first admin org whenever the session loads or the dialog opens.
  useEffect(() => {
    if (!orgId && adminOrgs.length > 0) setOrgId(adminOrgs[0].org_id);
  }, [adminOrgs, orgId]);

  function reset() {
    setStep(1);
    setAgentId('');
    setAgentType('claude-code');
    setCommand(null);
    setError(null);
    setCopied(false);
    setSubmitting(false);
  }

  async function createAgent() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, agent_id: agentId, agent_type: agentType }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `Request failed with ${res.status}`);
      }
      const data = await res.json();
      setCommand(data.command);
      setStep(2);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Poll agent detail every 2s while on step 2; flip to step 3 when a session comes online.
  useEffect(() => {
    if (step !== 2 || !agentId) return;
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`);
        if (!res.ok) return;
        const data = await res.json();
        const online = Array.isArray(data.sessions) && data.sessions.some((s: { status?: string }) => s.status === 'online');
        if (!cancelled && online) setStep(3);
      } catch { /* ignore transient errors */ }
    };
    const id = setInterval(check, 2000);
    check();
    return () => { cancelled = true; clearInterval(id); };
  }, [step, agentId]);

  async function copyCommand() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard may be unavailable */ }
  }

  if (!canCreate) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button>+ New agent</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
        </DialogHeader>

        <Stepper step={step} />

        {step === 1 && (
          <div className="flex flex-col gap-3">
            {adminOrgs.length > 1 && (
              <label className="flex flex-col gap-1 text-sm">
                Organization
                <select
                  className="rounded border bg-background px-2 py-1"
                  value={orgId}
                  onChange={(e) => setOrgId(e.target.value)}
                >
                  {adminOrgs.map((o) => (
                    <option key={o.org_id} value={o.org_id}>{o.org_id}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex flex-col gap-1 text-sm">
              Agent ID
              <input
                className="rounded border bg-background px-2 py-1"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="laptop-1"
                pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Agent type
              <select
                className="rounded border bg-background px-2 py-1"
                value={agentType}
                onChange={(e) => setAgentType(e.target.value as AgentType)}
              >
                {AGENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <span className="text-xs text-muted-foreground">
                Which CLI tool this runner will invoke when it claims work.
              </span>
            </label>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={createAgent} disabled={submitting || !agentId || !orgId}>
                {submitting ? 'Creating…' : 'Next →'}
              </Button>
            </div>
          </div>
        )}

        {step === 2 && command && (
          <div className="flex flex-col gap-3">
            <p className="text-sm">Run this on the machine where the runner should execute:</p>
            <pre className="overflow-auto rounded bg-muted p-3 text-xs">{command}</pre>
            <div className="flex items-center justify-between">
              <Button variant="outline" onClick={copyCommand}>
                {copied ? 'Copied ✓' : 'Copy command'}
              </Button>
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
                Waiting for the runner to connect…
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              The token is shown once. Copy it before closing — if lost, delete the agent and create a new one.
            </p>
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/20 text-2xl">
              ✓
            </div>
            <p className="text-sm font-medium">Connected</p>
            <p className="text-sm text-muted-foreground">{agentId} is online.</p>
            <Button onClick={() => setOpen(false)}>Done</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps = [
    { n: 1 as const, label: 'Name' },
    { n: 2 as const, label: 'Run' },
    { n: 3 as const, label: 'Connect' },
  ];
  return (
    <div className="mb-4 flex items-center">
      {steps.map((s, i) => (
        <div key={s.n} className={cn('flex items-center', i < steps.length - 1 && 'flex-1')}>
          <div
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs',
              step >= s.n ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground text-muted-foreground',
            )}
          >
            {s.n}
          </div>
          <span className={cn('ml-2 text-xs', step >= s.n ? '' : 'text-muted-foreground')}>{s.label}</span>
          {i < steps.length - 1 && (
            <div className={cn('mx-3 h-px flex-1', step > s.n ? 'bg-primary' : 'bg-muted-foreground/30')} />
          )}
        </div>
      ))}
    </div>
  );
}
