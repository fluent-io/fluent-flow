import { LegacyAdminGate } from '@/components/layout/legacy-admin-gate';

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return <LegacyAdminGate>{children}</LegacyAdminGate>;
}
