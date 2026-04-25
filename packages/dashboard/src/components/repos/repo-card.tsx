'use client';

import Link from 'next/link';
import type { RepoListItem } from '@fluent-flow/db';
import { Badge } from '@/components/ui/badge';
import { StartWorkflowDialog } from './start-workflow-dialog';

export function RepoCard({ repo }: { repo: RepoListItem }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <a
              href={`https://github.com/${repo.repo_full_name}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-primary hover:underline"
            >
              {repo.repo_full_name}
            </a>
            <Badge
              variant="outline"
              className={repo.is_active
                ? 'border-green-800 bg-green-950 text-green-400'
                : 'border-red-800 bg-red-950 text-red-400'
              }
            >
              {repo.is_active ? 'active' : 'suspended'}
            </Badge>
          </div>
          {repo.active_claims > 0 && (
            <Link
              href={`/pipelines?repo=${encodeURIComponent(repo.repo_full_name)}`}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {repo.active_claims} active pipeline{repo.active_claims !== 1 ? 's' : ''}
            </Link>
          )}
        </div>
        <StartWorkflowDialog repoId={repo.id} repoFullName={repo.repo_full_name} />
      </div>
    </div>
  );
}
