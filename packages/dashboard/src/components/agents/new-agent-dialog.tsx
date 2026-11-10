'use client';

import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Step = 1 | 2 | 3;
type Provider = 'claude-code' | 'codex';
type Deployment = 'local' | 'self_hosted';

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
];
const ACP_ADAPTER_PACKAGES: Record<Provider, string> = {
  'claude-code': '@agentclientprotocol/claude-agent-acp',
  codex: '@agentclientprotocol/codex-acp',
};
const POLL_FAILURE_ALERT_THRESHOLD = 3;
const DEPLOYMENTS: { value: Deployment; label: string }[] = [
  { value: 'local', label: 'Local (npm)' },
  { value: 'self_hosted', label: 'Self-hosted (Docker)' },
];
const DEFAULT_CAPACITY = '2';
const MIN_CAPACITY = 1;
const MAX_CAPACITY = 16;

function parseCapacity(input: string): number | null {
  if (input.trim() === '') return null;
  const value = Number(input);
  if (!Number.isInteger(value) || value < MIN_CAPACITY || value > MAX_CAPACITY) return null;
  return value;
}

export function NewAgentDialog() {
  const { data: session } = useSession();
  const router = useRouter();
  // Superadmins can create agents in any org they see — not just ones where
  // they carry an explicit 'admin' user_orgs row. For regular users we still
  // gate on 'admin' membership.
  const isSuperadmin = !!session?.user?.isSuperadmin;
  const eligibleOrgs = isSuperadmin
    ? (session?.user?.orgs ?? [])
    : (session?.user?.orgs ?? []).filter((o) => o.role === 'admin');
  const canCreate = eligibleOrgs.length > 0;

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>(1);
  const [orgId, setOrgId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [provider, setProvider] = useState<Provider>('claude-code');
  const [capacityInput, setCapacityInput] = useState(DEFAULT_CAPACITY);
  const [deployment, setDeployment] = useState<Deployment>('local');
  const [submitting, setSubmitting] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const [expiresInMinutes, setExpiresInMinutes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const fieldId = useId();
  const capacity = parseCapacity(capacityInput);
  const capacityInvalid = capacity === null;

  // Default org to first eligible org whenever the session loads or the dialog opens.
  useEffect(() => {
    if (!orgId && eligibleOrgs.length > 0) setOrgId(eligibleOrgs[0].org_id);
  }, [eligibleOrgs, orgId]);

  function reset() {
    setStep(1);
    setOrgId('');
    setAgentId('');
    setProvider('claude-code');
    setCapacityInput(DEFAULT_CAPACITY);
    setDeployment('local');
    setCommand(null);
    setExpiresInMinutes(0);
    setError(null);
    setCheckFailed(false);
    setCopied(false);
    setSubmitting(false);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  async function createAgent() {
    if (submitting || capacity === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, agent_id: agentId, provider, capacity, deployment }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `Request failed with ${res.status}`);
      }
      const data = await res.json();
      const expiresAt = new Date(data.enrollment_expires_at).getTime();
      if (typeof data.command !== 'string' || Number.isNaN(expiresAt)) {
        throw new Error('Unexpected response from the server');
      }
      setCommand(data.command);
      setExpiresInMinutes(Math.max(1, Math.round((expiresAt - Date.now()) / 60_000)));
      setStep(2);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Poll agent detail every 2s while on step 2; flip to step 3 when any slot reports a non-offline status.
  // Scope the poll to the org we just created in — agents are keyed by
  // (org_id, id), so sending orgId as `?org=` avoids matching a same-named
  // agent in another org the user belongs to.
  useEffect(() => {
    if (step !== 2 || !agentId || !orgId) return;
    let cancelled = false;
    let consecutiveFailures = 0;
    const recordFailure = () => {
      consecutiveFailures += 1;
      if (!cancelled && consecutiveFailures >= POLL_FAILURE_ALERT_THRESHOLD) setCheckFailed(true);
    };
    const check = async () => {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}?org=${encodeURIComponent(orgId)}`);
        if (!res.ok) {
          recordFailure();
          return;
        }
        const data = await res.json();
        consecutiveFailures = 0;
        if (!cancelled) setCheckFailed(false);
        const connected = Array.isArray(data.sessions)
          && data.sessions.some((s: { status?: unknown }) => typeof s.status === 'string' && s.status !== 'offline');
        if (!cancelled && connected) setStep(3);
      } catch {
        recordFailure();
      }
    };
    const id = setInterval(check, 2000);
    check();
    return () => { cancelled = true; clearInterval(id); };
  }, [step, agentId, orgId]);

  async function copyCommand() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard may be unavailable */ }
  }

  if (!canCreate) return null;

  const controlClass = 'rounded border bg-background px-2 py-1';
  const nameId = `${fieldId}-name`;
  const orgFieldId = `${fieldId}-org`;
  const providerId = `${fieldId}-provider`;
  const capacityId = `${fieldId}-capacity`;
  const capacityErrorId = `${fieldId}-capacity-error`;
  const deploymentId = `${fieldId}-deployment`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>+ New agent server</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New agent server</DialogTitle>
        </DialogHeader>

        <Stepper step={step} />

        {step === 1 && (
          <div className="flex flex-col gap-3">
            {eligibleOrgs.length > 1 && (
              <div className="flex flex-col gap-1 text-sm">
                <label htmlFor={orgFieldId}>Organization</label>
                <select
                  id={orgFieldId}
                  className={controlClass}
                  value={orgId}
                  onChange={(e) => setOrgId(e.target.value)}
                >
                  {eligibleOrgs.map((o) => (
                    <option key={o.org_id} value={o.org_id}>{o.org_id}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex flex-col gap-1 text-sm">
              <label htmlFor={nameId}>Server name</label>
              <input
                id={nameId}
                className={controlClass}
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="laptop-1"
                pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1 text-sm">
              <label htmlFor={providerId}>Provider</label>
              <select
                id={providerId}
                className={controlClass}
                value={provider}
                onChange={(e) => setProvider(e.target.value as Provider)}
              >
                {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1 text-sm">
              <label htmlFor={capacityId}>Capacity</label>
              <input
                id={capacityId}
                type="number"
                min={MIN_CAPACITY}
                max={MAX_CAPACITY}
                step={1}
                className={cn(controlClass, capacityInvalid && 'border-destructive')}
                value={capacityInput}
                onChange={(e) => setCapacityInput(e.target.value)}
                aria-invalid={capacityInvalid}
                aria-describedby={capacityInvalid ? capacityErrorId : undefined}
              />
              {capacityInvalid && (
                <span id={capacityErrorId} className="text-xs text-destructive">
                  Capacity must be a whole number between {MIN_CAPACITY} and {MAX_CAPACITY}.
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1 text-sm">
              <label htmlFor={deploymentId}>Deployment</label>
              <select
                id={deploymentId}
                className={controlClass}
                value={deployment}
                onChange={(e) => setDeployment(e.target.value as Deployment)}
              >
                {DEPLOYMENTS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => handleOpenChange(false)}>Cancel</Button>
              <Button onClick={createAgent} disabled={submitting || !agentId || !orgId || capacityInvalid}>
                {submitting ? 'Creating…' : 'Next →'}
              </Button>
            </div>
          </div>
        )}

        {step === 2 && command && (
          <div className="flex flex-col gap-3">
            {checkFailed && (
              <p role="alert" className="text-sm text-destructive">
                The connection check failed. Your server may still connect — keep this dialog open or check the agents list.
              </p>
            )}
            <p className="text-sm">Run this on the machine where the server should execute:</p>
            <pre className="whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs leading-relaxed">{command}</pre>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={copyCommand}>Copy command</Button>
                <span role="status" className="text-xs text-muted-foreground">{copied ? 'Copied ✓' : ''}</span>
              </div>
              <span role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
                Waiting for the server to connect…
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {`This command is valid for ${expiresInMinutes} ${expiresInMinutes === 1 ? 'minute' : 'minutes'} and is single-use. Copy it before closing — if it expires or is lost, delete the server and create a new one.`}
            </p>

            <SetupInstructions deployment={deployment} provider={provider} />
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/20 text-2xl">
              ✓
            </div>
            <p className="text-sm font-medium">Connected</p>
            <p className="text-sm text-muted-foreground">{agentId} is online.</p>
            <Button onClick={() => handleOpenChange(false)}>Done</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SetupInstructions({ deployment, provider }: { deployment: Deployment; provider: Provider }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const toggleId = `${id}-toggle`;
  const contentId = `${id}-content`;
  return (
    <div className="rounded-md border border-border bg-muted/50">
      <button
        type="button"
        id={toggleId}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-left hover:bg-muted/80 transition-colors rounded-md"
        onClick={() => setOpen(!open)}
      >
        <span>⚙ Setup instructions</span>
        <span className="text-muted-foreground">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div id={contentId} className="border-t border-border px-3 py-3 flex flex-col gap-3">
          {deployment === 'self_hosted' ? (
            <div>
              <p className="mb-1 text-xs font-medium">Provider credentials</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Place the provider credential file at the secret path mounted in the command before you run it.
                The state and work volumes in the command persist the enrollment, so keep them when you recreate the container.
              </p>
            </div>
          ) : (
            <div>
              <p className="mb-1 text-xs font-medium">Local requirements</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Local mode reuses the login of your provider CLI, so sign in with it on this machine first.
                The machine needs Node 20+, git and gh on its PATH.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Install the ACP adapter for your provider before you run the command:{' '}
                <code>npm install -g {ACP_ADAPTER_PACKAGES[provider]}</code>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
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
