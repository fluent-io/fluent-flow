import { Badge } from '@/components/ui/badge';

const typeColors: Record<string, string> = {
  'claude-code': 'border-indigo-800 bg-indigo-950 text-indigo-400',
  'codex': 'border-violet-800 bg-violet-950 text-violet-400',
  'aider': 'border-amber-800 bg-amber-950 text-amber-400',
  'devin': 'border-cyan-800 bg-cyan-950 text-cyan-400',
  'openclaw': 'border-emerald-800 bg-emerald-950 text-emerald-400',
  'custom': 'border-border bg-secondary text-muted-foreground',
};

export function TypeBadge({ type }: { type: string }) {
  const className = typeColors[type] ?? typeColors.custom;
  return (
    <Badge variant="outline" className={`text-xs font-normal ${className}`}>
      {type}
    </Badge>
  );
}
