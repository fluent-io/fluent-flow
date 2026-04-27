import { cn } from '@/lib/utils';

const stageConfig: Record<string, { label: string; color: string }> = {
  spec: { label: 'Spec', color: 'emerald' },
  build: { label: 'Build', color: 'amber' },
  review: { label: 'Review', color: 'violet' },
  review_fix: { label: 'Review Fix', color: 'indigo' },
  test_verify: { label: 'Test Verify', color: 'cyan' },
  security_review: { label: 'Security', color: 'rose' },
};

function getStageConfig(claimType: string) {
  return stageConfig[claimType] ?? { label: claimType, color: 'zinc' };
}

const statusStyles: Record<string, string> = {
  completed: 'bg-green-950 border-green-800 text-green-400',
  claimed: 'bg-amber-950 border-amber-800 text-amber-400',
  pending: 'bg-amber-950/50 border-amber-800/50 text-amber-400/70',
  failed: 'bg-red-950 border-red-800 text-red-400',
  expired: 'bg-red-950 border-red-800 text-red-400',
  cancelled: 'bg-zinc-900 border-zinc-700 text-zinc-400',
};

const statusIcons: Record<string, string> = {
  completed: '\u2713',
  claimed: '\u27F3',
  pending: '\u23F3',
  failed: '\u2717',
  expired: '\u2717',
  cancelled: '\u2717',
};

function formatDuration(start: string | Date | null, end: string | Date | null): string {
  if (!start || !end) return '';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

interface PipelineStageProps {
  claimType: string;
  status: string;
  createdAt?: string | null;
  claimedAt?: string | null;
  completedAt?: string | null;
  isFirst?: boolean;
  isLast?: boolean;
}

export function PipelineStage({ claimType, status, claimedAt, completedAt, isFirst, isLast }: PipelineStageProps) {
  const config = getStageConfig(claimType);
  const style = statusStyles[status] ?? 'bg-secondary border-border text-muted-foreground';
  const icon = statusIcons[status] ?? '\u2014';
  const duration = formatDuration(claimedAt ?? null, completedAt ?? null);

  return (
    <div
      className={cn(
        'flex-1 border px-3 py-2 text-center',
        style,
        isFirst && 'rounded-l-md',
        isLast && 'rounded-r-md',
      )}
    >
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{config.label}</div>
      <div className="text-[11px]">{icon} {status}</div>
      {duration && <div className="text-[9px] text-muted-foreground/70">{duration}</div>}
    </div>
  );
}

export { getStageConfig, formatDuration, statusIcons };
