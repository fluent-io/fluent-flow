import { getServerSession } from 'next-auth';
import { listAgents } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';
import { AgentTable } from '@/components/agents/agent-table';
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';

export default async function AgentsPage() {
  const session = await getServerSession(authOptions);
  if (!session) return null;

  const { orgIds } = getOrgScope(session);
  const agents = await listAgents(orgIds);

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Agents</h1>
          <p className="text-sm text-muted-foreground">Manage your org&apos;s AI agents</p>
        </div>
        <NewAgentDialog />
      </div>
      <AgentTable agents={agents} />
    </div>
  );
}
