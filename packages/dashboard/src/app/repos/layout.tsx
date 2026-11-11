import { InternalNavGate } from '@/components/layout/internal-nav-gate';

export default function ReposLayout({ children }: { children: React.ReactNode }) {
  return <InternalNavGate>{children}</InternalNavGate>;
}
