import { DashboardShell } from '@/components/layout/dashboard-shell';

export default function BoardLayout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
