import { getServerSession } from 'next-auth';
import { listPipelines } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';
import { PipelineCard } from '@/components/pipelines/pipeline-card';

export default async function PipelinesPage() {
  const session = await getServerSession(authOptions);
  if (!session) return null;

  const { orgIds } = getOrgScope(session);
  const pipelines = await listPipelines(orgIds);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Pipelines</h1>
        <p className="text-sm text-muted-foreground">Task pipeline status per PR</p>
      </div>
      {pipelines.length === 0 ? (
        <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-border">
          <p className="text-sm text-muted-foreground">No pipelines yet</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {pipelines.map((p) => (
            <PipelineCard key={`${p.repo}-${p.pr_number}`} pipeline={p} />
          ))}
        </div>
      )}
    </div>
  );
}
