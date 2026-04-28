export const START_WORKFLOW_CLAIM_TYPE = 'spec';

export function buildSpecWorkflowPayload(description: string | undefined | null): {
  claimType: typeof START_WORKFLOW_CLAIM_TYPE;
  description: string;
  prNumber: null;
  payload: Record<string, unknown>;
} {
  const trimmed = typeof description === 'string' ? description.trim() : '';
  return {
    claimType: START_WORKFLOW_CLAIM_TYPE,
    description: trimmed || START_WORKFLOW_CLAIM_TYPE,
    prNumber: null,
    payload: { auto_chain: true },
  };
}
