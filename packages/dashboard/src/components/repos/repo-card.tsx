'use client';

import Link from 'next/link';
import type { RepoListItem } from '@fluent-flow/db';
import { Badge } from '@/components/ui/badge';
import { StartWorkflowDialog } from './start-workflow-dialog';

function StatusBadge({ isActive }: { isActive: boolean | null }) {
  if (isActive === null) {
    return <Badge variant="outline" className="border-yellow-800 bg-yellow-950 text-yellow-400">unknown</Badge>;
  }
  return isActive
    ? <Badge variant="outline" className="border-green-800 bg-green-950 text-green-400">active</Badge>
    : <Badge variant="outline" className="border-red-800 bg-red-950 text-red-400">suspended</Badge>;
}

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
            <StatusBadge isActive={repo.is_active} />
          </div>
          {repo.active_claims > 0 && (
            <Link
              href="/pipelines"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {repo.active_claims} active claim{repo.active_claims !== 1 ? 's' : ''}
            </Link>
          )}
        </div>
        <StartWorkflowDialog repoId={repo.id} repoFullName={repo.repo_full_name} />
      </div>
    </div>
  );
}
