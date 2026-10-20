import { LegacyAdminGate } from '@/components/layout/legacy-admin-gate';

export default function PipelinesLayout({ children }: { children: React.ReactNode }) {
  return <LegacyAdminGate>{children}</LegacyAdminGate>;
}
