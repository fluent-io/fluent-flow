import { DashboardShell } from '@/components/layout/dashboard-shell';

export default function ProjectsLayout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
