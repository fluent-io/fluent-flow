import type { AgentDetail } from '@fluent-flow/db';

const EM_DASH = '\u2014';

const DEPLOYMENT_LABELS: Record<NonNullable<AgentDetail['deployment']>, string> = {
  local: 'Local',
  self_hosted: 'Self-hosted',
  hosted: 'Hosted',
};

export function formatSlots(agent: Pick<AgentDetail, 'active_slots' | 'capacity'>): string {
  return `${agent.active_slots} / ${agent.capacity ?? EM_DASH}`;
}

export function formatDeployment(deployment: AgentDetail['deployment']): string {
  return deployment ? DEPLOYMENT_LABELS[deployment] : EM_DASH;
}
