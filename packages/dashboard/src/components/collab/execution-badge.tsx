import type { HostReachability, RunState } from '@/lib/collab/types';
import { cn } from '@/lib/utils';

const RUN_STATE_LABEL: Record<RunState, string> = {
  queued: 'Queued for host',
  launching: 'Launching',
  running: 'Running',
  needs_input: 'Needs input',
  idle: 'Idle',
  failed: 'Error',
  cancel_requested: 'Cancelling…',
  cancelled: 'Cancelled',
  reconciling: 'Reconciling',
};

const RUN_STATE_CLASS: Record<RunState, string> = {
  queued: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  launching: 'border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  running: 'border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  needs_input: 'border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400',
  idle: 'border-border bg-secondary text-muted-foreground',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  cancel_requested: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  cancelled: 'border-border bg-secondary text-muted-foreground',
  reconciling: 'border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400',
};

/**
 * Client-safe execution badge. Reflects only the server's safe projection —
 * never raw session/transcript payloads.
 */
export function ExecutionBadge({
  state,
  reachability,
  attentionCount,
}: {
  state: RunState | null;
  reachability: HostReachability | null;
  attentionCount?: number;
}) {
  if (!state) return null;
  const offline = reachability === 'offline' || reachability === 'stale';
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('rounded border px-1.5 py-0.5 text-[11px] font-medium', RUN_STATE_CLASS[state])}>
        {RUN_STATE_LABEL[state]}
        {offline ? ' · host offline' : ''}
      </span>
      {attentionCount && attentionCount > 0 ? (
        <span className="rounded border border-orange-500/40 bg-orange-500/10 px-1.5 py-0.5 text-[11px] font-medium text-orange-600 dark:text-orange-400">
          {attentionCount} attention
        </span>
      ) : null}
    </span>
  );
}
