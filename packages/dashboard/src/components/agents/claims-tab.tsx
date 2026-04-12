import type { Claim } from '@fluent-flow/db';
import { StatusBadge } from './status-badge';
import { ClaimTypeBadge } from './claim-type-badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

function formatDate(date: Date | string | null): string {
  if (!date) return '\u2014';
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function ClaimsTab({ claims }: { claims: Claim[] }) {
  if (claims.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No claims recorded</p>;
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead>Repo / PR</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Claimed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {claims.map((c) => (
            <TableRow key={c.id}>
              <TableCell><ClaimTypeBadge type={c.claim_type} /></TableCell>
              <TableCell>
                <a
                  href={`https://github.com/${c.repo}/pull/${c.pr_number}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {c.repo} #{c.pr_number}
                </a>
              </TableCell>
              <TableCell><StatusBadge status={c.status} /></TableCell>
              <TableCell className="text-muted-foreground">{formatDate(c.claimed_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
