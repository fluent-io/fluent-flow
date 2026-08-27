import { cn } from '@/lib/utils';
import { getStageConfig, formatDuration, statusIcons } from './pipeline-stage-config';


const stageLabelStyles: Record<string, string> = {
  emerald: 'text-emerald-300',
  amber: 'text-amber-300',
  violet: 'text-violet-300',
  indigo: 'text-indigo-300',
  cyan: 'text-cyan-300',
  sky: 'text-sky-300',
  rose: 'text-rose-300',
  red: 'text-red-300',
  green: 'text-green-300',
};

const statusStyles: Record<string, string> = {
  completed: 'bg-green-950 border-green-800 text-green-400',
  claimed: 'bg-amber-950 border-amber-800 text-amber-400',
  pending: 'bg-amber-950/50 border-amber-800/50 text-amber-400/70',
  failed: 'bg-red-950 border-red-800 text-red-400',
  expired: 'bg-red-950 border-red-800 text-red-400',
  cancelled: 'bg-zinc-900 border-zinc-700 text-zinc-400',
};


interface PipelineStageProps {
  claimType: string;
  status: string;
  createdAt?: string | null;
  claimedAt?: string | null;
  completedAt?: string | null;
  phase?: string | null;
  isFirst?: boolean;
  isLast?: boolean;
}

export function PipelineStage({ claimType, status, claimedAt, completedAt, isFirst, isLast, phase }: PipelineStageProps) {
  const config = getStageConfig(claimType, phase);
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
      <div className={cn('text-[9px] uppercase tracking-wider', stageLabelStyles[config.color] ?? 'text-muted-foreground')}>{config.label}</div>
      <div className="text-[11px]">{icon} {status}</div>
      {duration && <div className="text-[9px] text-muted-foreground/70">{duration}</div>}
    </div>
  );
}

export { getStageConfig, formatDuration, statusIcons };
