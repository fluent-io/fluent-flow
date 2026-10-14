import Link from 'next/link';
import { getServerSession } from 'next-auth';
import { authOptions, getOrgScope, hasRole } from '@/lib/auth';
import { loadDb } from '@/lib/runtime-db';
import { AgentDetailHeader } from '@/components/agents/agent-detail-header';
import { SessionsTab } from '@/components/agents/sessions-tab';
import { ClaimsTab } from '@/components/agents/claims-tab';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { notFound } from 'next/navigation';


export const dynamic = 'force-dynamic';
export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return null;

  const { id } = await params;
  const { orgIds } = getOrgScope(session);
  const { getAgentDetail, getAgentSessions, getAgentClaims, getKeyInfo } = await loadDb();
  const agent = await getAgentDetail(orgIds, id);

  if (!agent) notFound();

  const [sessions, claims, key] = await Promise.all([
    getAgentSessions(agent.org_id, agent.id),
    getAgentClaims(agent.org_id, agent.id),
    getKeyInfo(agent.org_id, agent.id),
  ]);

  const latestSession = sessions[0] ?? null;
  const isAdmin = hasRole(session, agent.org_id, 'admin');

  return (
    <div>
      <div className="mb-4 text-xs text-muted-foreground">
        <Link href="/agents" className="text-primary hover:underline">Agents</Link>
        <span className="mx-1">/</span>
        {agent.id}
      </div>

      <AgentDetailHeader
        agent={agent}
        keyInfo={key}
        status={latestSession?.status ?? 'offline'}
        isAdmin={isAdmin}
      />

      <Tabs defaultValue="sessions" className="mt-6">
        <TabsList>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="claims">Claims</TabsTrigger>
        </TabsList>
        <TabsContent value="sessions" className="mt-4">
          <SessionsTab sessions={sessions} />
        </TabsContent>
        <TabsContent value="claims" className="mt-4">
          <ClaimsTab claims={claims} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
