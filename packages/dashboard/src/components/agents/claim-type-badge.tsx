import { Badge } from '@/components/ui/badge';

const claimTypeColors: Record<string, string> = {
  spec: 'border-emerald-800 bg-emerald-950 text-emerald-400',
  build: 'border-amber-800 bg-amber-950 text-amber-400',
  review_fix: 'border-indigo-800 bg-indigo-950 text-indigo-400',
  test_verify: 'border-cyan-800 bg-cyan-950 text-cyan-400',
};

export function ClaimTypeBadge({ type }: { type: string }) {
  const className = claimTypeColors[type] ?? 'border-border bg-secondary text-muted-foreground';
  return (
    <Badge variant="outline" className={`text-xs font-normal ${className}`}>
      {type}
    </Badge>
  );
}
