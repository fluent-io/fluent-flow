import { InternalNavGate } from '@/components/layout/internal-nav-gate';

export default function PipelinesLayout({ children }: { children: React.ReactNode }) {
  return <InternalNavGate>{children}</InternalNavGate>;
}
