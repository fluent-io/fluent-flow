import { DashboardShell } from '@/components/layout/dashboard-shell';

export default function AttentionLayout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
