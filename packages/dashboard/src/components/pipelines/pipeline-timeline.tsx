import type { PipelineDetailClaim } from '@fluent-flow/db';
import { getStageConfig, formatDuration, statusIcons } from './pipeline-stage';
import { cn } from '@/lib/utils';

const nodeStyles: Record<string, string> = {
  completed: 'border-green-500 bg-green-950 text-green-400',
  claimed: 'border-amber-500 bg-amber-950 text-amber-400',
  pending: 'border-amber-500/50 bg-amber-950/50 text-amber-400/70',
  failed: 'border-red-500 bg-red-950 text-red-400',
  expired: 'border-red-500 bg-red-950 text-red-400',
};

const lineStyles: Record<string, string> = {
  completed: 'bg-green-800',
  claimed: 'bg-amber-800',
  pending: 'bg-border',
  failed: 'bg-red-800',
  expired: 'bg-red-800',
};

function formatTime(date: Date | string | null): string {
  if (!date) return '';
  return new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date: Date | string | null): string {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function PipelineTimeline({ claims }: { claims: PipelineDetailClaim[] }) {
  if (claims.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No pipeline stages found</p>;
  }

  return (
    <div className="flex flex-col">
      {claims.map((claim, i) => {
        const config = getStageConfig(claim.claim_type);
        const icon = statusIcons[claim.status] ?? '\u2014';
        const nodeStyle = nodeStyles[claim.status] ?? 'border-border bg-secondary text-muted-foreground';
        const lineStyle = lineStyles[claim.status] ?? 'bg-border';
        const duration = formatDuration(claim.claimed_at, claim.completed_at);
        const isLast = i === claims.length - 1;
        const meta = (claim.session_meta ?? {}) as Record<string, unknown>;

        return (
          <div key={claim.id} className="flex gap-4">
            <div className="flex w-6 flex-col items-center">
              <div className={cn('flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs', nodeStyle)}>
                {icon}
              </div>
              {!isLast && <div className={cn('w-0.5 flex-1', lineStyle)} />}
            </div>
            <div className="mb-3 flex-1 rounded-lg border border-border bg-card p-3.5">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{config.label}</span>
                  <span className="text-xs text-muted-foreground">{claim.status}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {duration && `${duration} \u00b7 `}{formatDate(claim.created_at)} {formatTime(claim.created_at)}
                  {claim.completed_at && ` \u2192 ${formatTime(claim.completed_at)}`}
                </span>
              </div>
              <div className="flex gap-4 text-xs text-muted-foreground">
                {claim.agent_id && <div>Agent: <span className="text-foreground">{claim.agent_id}</span></div>}
                {claim.session_id && <div>Session: <span className="text-foreground">#{claim.session_id}</span></div>}
                {typeof meta.hostname === 'string' && <div>Host: <span className="text-foreground">{meta.hostname}</span></div>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
