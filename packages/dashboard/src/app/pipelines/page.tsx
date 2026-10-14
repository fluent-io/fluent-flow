import { getServerSession } from 'next-auth';
import type { PipelineListItem } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';
import { loadDb } from '@/lib/runtime-db';
import { PipelineCard } from '@/components/pipelines/pipeline-card';
import { PipelineFilterToggle } from '@/components/pipelines/pipeline-filter-toggle';
import { DismissStaleButton } from '@/components/pipelines/dismiss-stale-button';
import { Suspense } from 'react';

export const dynamic = 'force-dynamic';

function PipelinesContent({ pipelines }: { pipelines: PipelineListItem[] }) {
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Pipelines</h1>
          <p className="text-sm text-muted-foreground">Task pipeline status per PR</p>
        </div>
        <div className="flex items-center gap-3">
          <Suspense>
            <PipelineFilterToggle />
          </Suspense>
          <DismissStaleButton />
        </div>
      </div>
      {pipelines.length === 0 ? (
        <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-border">
          <p className="text-sm text-muted-foreground">No pipelines found</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {pipelines.map((p) => (
            <PipelineCard key={`${p.repo}-${p.pr_number ?? 'standalone'}`} pipeline={p} />
          ))}
        </div>
      )}
    </div>
  );
}

export default async function PipelinesPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return null;

  const { orgIds } = getOrgScope(session);
  const params = await searchParams;
  const filter = (params.filter ?? 'active') as 'active' | 'archived' | 'all';
  const { listPipelines } = await loadDb();
  const pipelines = await listPipelines(orgIds, filter);

  return <PipelinesContent pipelines={pipelines} />;
}
