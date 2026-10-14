import type { ArtifactRow, ListRow, MatrixRequirement, SuiteTotals as SuiteTotalsModel, VerificationClaim } from './verification-panel-model';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { commitHref, displayValue, getVerificationCardModel, shortSha } from './verification-panel-model';


const outcomeStyles: Record<string, string> = {
  PASS: 'border-green-800 bg-green-950 text-green-400',
  FAIL: 'border-red-800 bg-red-950 text-red-400',
  TAMPERED: 'border-rose-800 bg-rose-950 text-rose-400',
  SKIPPED: 'border-zinc-700 bg-zinc-900 text-zinc-400',
};

const statusStyles: Record<string, string> = {
  PASS: 'border-green-800 bg-green-950 text-green-400',
  FAIL: 'border-red-800 bg-red-950 text-red-400',
  TAMPERED: 'border-rose-800 bg-rose-950 text-rose-400',
  SKIPPED: 'border-zinc-700 bg-zinc-900 text-zinc-400',
};


function StatusPill({ value, fallback = '—' }: { value: string; fallback?: string }) {
  const normalized = value === '—' ? fallback : value.toUpperCase();
  const className = statusStyles[normalized] ?? 'border-border bg-secondary text-muted-foreground';
  return (
    <Badge variant="outline" className={cn('text-[11px] font-normal', className)}>
      {normalized}
    </Badge>
  );
}

function OutcomeBadge({ outcome }: { outcome: string | null | undefined }) {
  const normalized = displayValue(outcome).toUpperCase();
  const className = outcomeStyles[normalized] ?? 'border-border bg-secondary text-muted-foreground';
  return (
    <Badge variant="outline" className={cn('text-xs font-normal', className)}>
      ● {normalized}
    </Badge>
  );
}

function SuiteTotals({ suite }: { suite: SuiteTotalsModel }) {
  const totals = [
    ['Total', suite.total],
    ['Passed', suite.passed],
    ['Failed', suite.failed],
    ['Flaky', suite.flaky],
    ['Skipped', suite.skipped],
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {totals.map(([label, value]) => (
        <div key={label} className="rounded-md border border-border bg-secondary/30 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="font-mono text-lg tabular-nums text-foreground">{value}</div>
        </div>
      ))}
    </div>
  );
}

function MatrixTable({ requirements }: { requirements: MatrixRequirement[] }) {
  if (requirements.length === 0) {
    return <p className="rounded-md border border-dashed border-border py-4 text-center text-xs text-muted-foreground">No requirement matrix rows recorded</p>;
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Finding</TableHead>
            <TableHead>Requirement</TableHead>
            <TableHead>Tests</TableHead>
            <TableHead>Red</TableHead>
            <TableHead>Green</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {requirements.map((requirement, index) => (
            <TableRow key={`${requirement.requirement}-${index}`}>
              <TableCell className="align-top font-mono text-xs text-muted-foreground">{requirement.finding}</TableCell>
              <TableCell className="align-top">
                <div className="font-mono text-xs text-foreground">{requirement.requirement}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">Overall: {requirement.status}</div>
              </TableCell>
              <TableCell className="align-top">
                {requirement.tests.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    {requirement.tests.map((test) => (
                      <code key={test} className="break-all rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {test}
                      </code>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="align-top"><StatusPill value={requirement.redStatus} /></TableCell>
              <TableCell className="align-top">
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusPill value={requirement.greenStatus} />
                  {requirement.flaky && <Badge variant="outline" className="border-amber-800 bg-amber-950 text-[11px] font-normal text-amber-400">flaky</Badge>}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function DetailRows({ title, rows, empty }: { title: string; rows: ListRow[]; empty: string }) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h4>
      {rows.length > 0 ? (
        <div className="space-y-2">
          {rows.map((row, index) => (
            <div key={`${row.label}-${index}`} className="rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-foreground">{row.label}</span>
                <span className="text-muted-foreground">{row.detail}</span>
              </div>
              {row.message !== '—' && <div className="mt-1 text-muted-foreground">{row.message}</div>}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

function ArtifactRows({ repo, rows }: { repo: string; rows: ArtifactRow[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No artifact SHAs recorded</p>;
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {rows.map((row) => {
        const href = commitHref(repo, row.sha);
        const value = <span className="font-mono tabular-nums">{shortSha(row.sha)}</span>;
        return (
          <div key={`${row.label}-${row.sha}`} className="rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{row.label}</div>
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                {value} ↗
              </a>
            ) : (
              <div className="break-all text-foreground">{value}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HashRows({ rows }: { rows: ArtifactRow[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No pinned test hashes recorded</p>;
  }

  return (
    <div className="space-y-1.5">
      {rows.map((row) => (
        <div key={`${row.label}-${row.sha}`} className="grid gap-1 rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto]">
          <code className="break-all text-muted-foreground">{row.label}</code>
          <span className="font-mono tabular-nums text-foreground">{shortSha(row.sha)}</span>
        </div>
      ))}
    </div>
  );
}

function VerificationCard({ claim }: { claim: VerificationClaim }) {
  const model = getVerificationCardModel(claim);
  const result = model.result;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">Verification {model.phase}</h3>
            <OutcomeBadge outcome={model.outcome} />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Attempt: <span className="text-foreground">{claim.attempt}</span></span>
            <span>Claim: <span className="font-mono text-foreground">#{claim.id}</span></span>
            <span>Framework: <span className="text-foreground">{model.framework}</span></span>
          </div>
        </div>
      </div>

      {result ? (
        <div className="space-y-5">
          <SuiteTotals suite={model.suite} />
          <MatrixTable requirements={model.requirements} />
          <div className="grid gap-4 lg:grid-cols-2">
            <DetailRows title="Flakes" rows={model.flakes} empty="No flaky verification rows recorded" />
            <DetailRows title="Warnings" rows={model.warnings} empty="No warning rows recorded" />
          </div>
          <div>
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Unverified findings</h4>
            {model.unverifiedFindings.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {model.unverifiedFindings.map((finding) => (
                  <Badge key={finding} variant="outline" className="border-amber-800 bg-amber-950 text-xs font-normal text-amber-400">
                    {finding}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No unverified findings recorded</p>
            )}
          </div>
          <div>
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Artifacts</h4>
            <ArtifactRows repo={claim.repo} rows={model.artifacts} />
          </div>
          <div>
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Pinned test hashes</h4>
            <HashRows rows={model.hashes} />
          </div>
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-border py-4 text-center text-xs text-muted-foreground">
          No verification result captured for this verify claim yet
        </p>
      )}
    </div>
  );
}

export function VerificationPanel({ claims }: { claims: VerificationClaim[] }) {
  const verificationClaims = claims.filter((claim) => claim.claim_type === 'verify' || claim.verification_result);

  if (verificationClaims.length === 0) return null;

  return (
    <section className="mb-6 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Verification results</h2>
        <p className="text-xs text-muted-foreground">Red/green verification chain, requirement matrix, suite totals, and persisted artifacts.</p>
      </div>
      <div className="space-y-3">
        {verificationClaims.map((claim) => (
          <VerificationCard key={claim.id} claim={claim} />
        ))}
      </div>
    </section>
  );
}
