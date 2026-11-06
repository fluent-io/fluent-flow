import { DashboardShell } from '@/components/layout/dashboard-shell';

export default function TasksLayout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
