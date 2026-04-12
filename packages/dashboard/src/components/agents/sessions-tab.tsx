import type { Session as AgentSession } from '@fluent-flow/db';
import { StatusBadge } from './status-badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function SessionsTab({ sessions }: { sessions: AgentSession[] }) {
  if (sessions.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No sessions recorded</p>;
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Hostname</TableHead>
            <TableHead>OS</TableHead>
            <TableHead>Connected</TableHead>
            <TableHead>Last Poll</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((s) => {
            const meta = (s.session_meta ?? {}) as Record<string, unknown>;
            return (
              <TableRow key={s.id}>
                <TableCell><StatusBadge status={s.status} /></TableCell>
                <TableCell>{(meta.hostname as string) ?? '\u2014'}</TableCell>
                <TableCell className="text-muted-foreground">{(meta.os as string) ?? '\u2014'}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(s.registered_at)}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(s.last_seen_at)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
