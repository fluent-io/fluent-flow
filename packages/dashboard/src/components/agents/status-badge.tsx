import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const statusConfig = {
  online: { label: 'online', className: 'border-green-800 bg-green-950 text-green-400' },
  offline: { label: 'offline', className: 'border-border bg-secondary text-muted-foreground' },
  busy: { label: 'busy', className: 'border-amber-800 bg-amber-950 text-amber-400' },
} as const;

export function StatusBadge({ status }: { status: string | null }) {
  const config = statusConfig[(status as keyof typeof statusConfig) ?? 'offline'] ?? statusConfig.offline;
  return (
    <Badge variant="outline" className={cn('text-xs font-normal', config.className)}>
      <span className="mr-1">●</span>
      {config.label}
    </Badge>
  );
}
