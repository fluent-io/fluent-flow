import { redirect } from 'next/navigation';
import { taskHref, taskSelection } from '@/lib/collab/task-navigation';
export default async function TaskPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const selection = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) if (typeof value === 'string') selection.set(name, value);
  selection.set('taskId', id);
  const { taskId, claimId, runId, sessionId } = taskSelection(selection);
  redirect(taskHref(selection.toString(), taskId, claimId, runId ? { runId, sessionId } : null));
}
