import { DashboardShell } from '@/components/layout/dashboard-shell';

export default function ReposLayout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
