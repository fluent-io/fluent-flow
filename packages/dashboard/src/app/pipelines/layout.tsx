import { DashboardShell } from '@/components/layout/dashboard-shell';

export default function PipelinesLayout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
