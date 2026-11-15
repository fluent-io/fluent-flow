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

export function formatBusy(agent: Pick<AgentDetail, 'busy_chat' | 'busy_work'>): string {
  return `chat ${agent.busy_chat} / work ${agent.busy_work}`;
}

export function chatCapacity(agent: Pick<AgentDetail, 'max_chat_slots' | 'capacity'>): {
  configured: number | null;
  effective: number | null;
  disabled: boolean;
} {
  const configured = agent.max_chat_slots;
  const capacity = agent.capacity;
  const effective = configured === 0 ? 0 : capacity === null ? null : Math.min(configured ?? capacity - 1, capacity - 1);
  return { configured, effective, disabled: effective !== null && effective <= 0 };
}

export function formatChatCapacity(agent: Pick<AgentDetail, 'max_chat_slots' | 'capacity'>): string {
  const { configured, effective, disabled } = chatCapacity(agent);
  const configuredLabel = configured === null ? 'default' : String(configured);
  if (effective === null) return `unknown (agent capacity not advertised) · configured ${configuredLabel}`;
  if (disabled) return `chats disabled · configured ${configuredLabel}`;
  return `${effective} effective of ${agent.capacity} · configured ${configuredLabel}`;
}

export function formatDeployment(deployment: AgentDetail['deployment']): string {
  return deployment ? DEPLOYMENT_LABELS[deployment] : EM_DASH;
}
