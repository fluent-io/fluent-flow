'use client';

import { useRouter } from 'next/navigation';
import type { PipelineListItem } from '@fluent-flow/db';
import { PipelineStage } from './pipeline-stage';
import { Badge } from '@/components/ui/badge';

function derivePipelineStatus(stages: { status: string }[]): { label: string; className: string } {
  const hasActive = stages.some((s) => s.status === 'pending' || s.status === 'claimed');
  const hasFailed = stages.some((s) => s.status === 'failed' || s.status === 'expired');

  if (hasActive) return { label: 'in progress', className: 'border-amber-800 bg-amber-950 text-amber-400' };
  if (hasFailed) return { label: 'failed', className: 'border-red-800 bg-red-950 text-red-400' };
  return { label: 'completed', className: 'border-green-800 bg-green-950 text-green-400' };
}

function timeAgo(date: Date | string | null): string {
  if (!date) return '';
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function PipelineCard({ pipeline }: { pipeline: PipelineListItem }) {
  const router = useRouter();
  const status = derivePipelineStatus(pipeline.stages);
  const [owner, repo] = pipeline.repo.split('/');
  const prSlug = pipeline.pr_number != null ? `/${pipeline.pr_number}` : '/no-pr';
  const prDisplay = pipeline.pr_number != null ? `#${pipeline.pr_number}` : 'Standalone';

  return (
    <div
      className="cursor-pointer rounded-lg border border-border bg-card p-4 transition-colors hover:border-muted-foreground/30"
      onClick={() => router.push(`/pipelines/${owner}/${repo}${prSlug}`)}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          {pipeline.pr_number != null ? (
            <a
              href={`https://github.com/${pipeline.repo}/pull/${pipeline.pr_number}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {pipeline.repo} #{pipeline.pr_number}
            </a>
          ) : (
            <span className="text-sm font-medium text-primary">
              {pipeline.repo} — Standalone
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`text-xs font-normal ${status.className}`}>
            ● {status.label}
          </Badge>
          <span className="text-xs text-muted-foreground">{timeAgo(pipeline.last_activity)}</span>
        </div>
      </div>
      <div className="flex items-center gap-px">
        {pipeline.stages.map((stage, i) => (
          <PipelineStage
            key={stage.claim_type}
            claimType={stage.claim_type}
            status={stage.status}
            claimedAt={stage.claimed_at}
            completedAt={stage.completed_at}
            isFirst={i === 0}
            isLast={i === pipeline.stages.length - 1}
          />
        ))}
      </div>
    </div>
  );
}
