import { DashboardShell } from '@/components/layout/dashboard-shell';

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
