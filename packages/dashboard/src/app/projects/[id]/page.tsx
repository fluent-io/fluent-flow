import { ProjectDetailPage } from '@/components/collab/projects-view';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectDetailPage key={id} projectId={id} />;
}
