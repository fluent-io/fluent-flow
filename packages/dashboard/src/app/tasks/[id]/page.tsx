import { Suspense } from 'react';
import { TaskDetailPage } from '@/components/collab/task-detail';

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <TaskDetailPage taskId={id} />
    </Suspense>
  );
}
