import Link from 'next/link';
import { getServerSession } from 'next-auth';
import { getPipelineDetail } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';
import { PipelineTimeline } from '@/components/pipelines/pipeline-timeline';
import { Badge } from '@/components/ui/badge';
import { notFound } from 'next/navigation';

function derivePipelineStatus(claims: { status: string }[]): { label: string; className: string } {
  const hasActive = claims.some((s) => s.status === 'pending' || s.status === 'claimed');
  const hasFailed = claims.some((s) => s.status === 'failed' || s.status === 'expired');

  if (hasActive) return { label: 'in progress', className: 'border-amber-800 bg-amber-950 text-amber-400' };
  if (hasFailed) return { label: 'failed', className: 'border-red-800 bg-red-950 text-red-400' };
  return { label: 'completed', className: 'border-green-800 bg-green-950 text-green-400' };
}

function formatDuration(start: Date | string, end: Date | string | null): string {
  const endTime = end ? new Date(end).getTime() : Date.now();
  const ms = endTime - new Date(start).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export default async function PipelineDetailPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return null;

  const { slug } = await params;
  if (slug.length < 3) notFound();

  const owner = slug[0];
  const repo = slug[1];
  const prNumber = parseInt(slug[2], 10);
  if (isNaN(prNumber)) notFound();

  const fullRepo = `${owner}/${repo}`;
  const { orgIds } = getOrgScope(session);
  const claims = await getPipelineDetail(orgIds, fullRepo, prNumber);

  if (claims.length === 0) notFound();

  const status = derivePipelineStatus(claims);
  const firstClaim = claims[0];
  const lastClaim = claims[claims.length - 1];
  const totalDuration = formatDuration(firstClaim.created_at, lastClaim.completed_at);

  return (
    <div>
      <div className="mb-4 text-xs text-muted-foreground">
        <Link href="/pipelines" className="text-primary hover:underline">Pipelines</Link>
        <span className="mx-1">/</span>
        {fullRepo} #{prNumber}
      </div>

      <div className="mb-6 rounded-lg border border-border bg-card p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2.5">
              <h1 className="text-xl font-semibold">{fullRepo} #{prNumber}</h1>
              <Badge variant="outline" className={`text-xs font-normal ${status.className}`}>
                ● {status.label}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
              {firstClaim.agent_id && <div>Agent: <span className="text-primary">{firstClaim.agent_id}</span></div>}
              <div>Attempt: {firstClaim.attempt}</div>
              <div>Started: {new Date(firstClaim.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
              <div>Duration: {totalDuration}</div>
            </div>
          </div>
          <a
            href={`https://github.com/${fullRepo}/pull/${prNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline"
          >
            View on GitHub ↗
          </a>
        </div>
      </div>

      <PipelineTimeline claims={claims} />
    </div>
  );
}
