import { InternalNavGate } from '@/components/layout/internal-nav-gate';

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return <InternalNavGate>{children}</InternalNavGate>;
}
