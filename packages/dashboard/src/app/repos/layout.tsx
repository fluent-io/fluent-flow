import { LegacyAdminGate } from '@/components/layout/legacy-admin-gate';

export default function ReposLayout({ children }: { children: React.ReactNode }) {
  return <LegacyAdminGate>{children}</LegacyAdminGate>;
}
