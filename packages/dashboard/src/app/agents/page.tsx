import { getServerSession } from 'next-auth';
import { listAgents } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';
import { AgentTable } from '@/components/agents/agent-table';

export default async function AgentsPage() {
  const session = await getServerSession(authOptions);
  if (!session) return null;

  const { orgIds } = getOrgScope(session);
  const agents = await listAgents(orgIds);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Agents</h1>
        <p className="text-sm text-muted-foreground">Manage your org&apos;s AI agents</p>
      </div>
      <AgentTable agents={agents} />
    </div>
  );
}
