'use client';

import { useRouter } from 'next/navigation';
import type { AgentListItem } from '@fluent-flow/db';
import { StatusBadge } from './status-badge';
import { TypeBadge } from './type-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

function timeAgo(date: Date | string | null): string {
  if (!date) return '\u2014';
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function AgentTable({ agents }: { agents: AgentListItem[] }) {
  const router = useRouter();

  if (agents.length === 0) {
    return (
      <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-border">
        <p className="text-sm text-muted-foreground">No agents registered</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last Seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {agents.map((agent) => (
            <TableRow
              key={agent.id}
              className="cursor-pointer"
              onClick={() => router.push(`/agents/${agent.id}`)}
            >
              <TableCell className="font-medium">{agent.id}</TableCell>
              <TableCell><TypeBadge type={agent.agent_type} /></TableCell>
              <TableCell><StatusBadge status={agent.status} /></TableCell>
              <TableCell className="text-muted-foreground">{timeAgo(agent.last_seen_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
