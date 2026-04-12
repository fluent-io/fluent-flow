'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Agent } from '@fluent-flow/db';
import { StatusBadge } from './status-badge';
import { TypeBadge } from './type-badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';

interface AgentDetailHeaderProps {
  agent: Agent;
  keyInfo: { id: number; created_at: string } | null;
  status: string | null;
  isAdmin: boolean;
}

export function AgentDetailHeader({ agent, keyInfo, status, isAdmin }: AgentDetailHeaderProps) {
  const router = useRouter();
  const [newKey, setNewKey] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleRegenerate() {
    setRegenerating(true);
    const res = await fetch(`/api/agents/${agent.id}/key`, { method: 'POST' });
    const data = await res.json();
    setNewKey(data.plaintext);
    setRegenerating(false);
  }

  async function handleDelete() {
    setDeleting(true);
    await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
    setDeleting(false);
    setDeleteOpen(false);
    router.push('/agents');
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2.5">
            <h1 className="text-xl font-semibold">{agent.id}</h1>
            <StatusBadge status={status} />
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <div>Type: <TypeBadge type={agent.agent_type} /></div>
            <div>Transport: {agent.transport}</div>
            <div>Registered: {new Date(agent.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
            <div>Repos: {agent.repos.join(', ')}</div>
          </div>
        </div>
        {isAdmin && (
          <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="border-destructive text-destructive hover:bg-destructive/10">
                Delete Agent
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete {agent.id}?</DialogTitle>
                <DialogDescription>
                  This will permanently delete the agent, revoke its API key, and fail any active claims. This action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
                <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
                  {deleting ? 'Deleting...' : 'Delete'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
        {newKey ? (
          <div className="w-full rounded-md border border-green-800 bg-green-950 p-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-green-400">New API key generated</span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-xs"
                onClick={() => navigator.clipboard.writeText(newKey)}
              >
                Copy
              </Button>
            </div>
            <code className="block rounded border border-border bg-background p-2 font-mono text-xs">
              {newKey}
            </code>
            <p className="mt-2 text-xs text-amber-400">
              Copy this key now. It won&apos;t be shown again.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">API Key</span>
              <span className="text-xs text-muted-foreground">
                {keyInfo ? `Created ${new Date(keyInfo.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : 'No key'}
              </span>
            </div>
            {isAdmin && (
              <Button variant="outline" size="sm" className="border-amber-700 text-amber-400 hover:bg-amber-950" onClick={handleRegenerate} disabled={regenerating}>
                {regenerating ? 'Regenerating...' : 'Regenerate'}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
