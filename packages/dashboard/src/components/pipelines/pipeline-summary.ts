type PipelineStatusClaim = { status: string };
type AttemptClaim = { attempt: number };
type HeaderClaim = AttemptClaim & { agent_id: string | null };

export function derivePipelineStatus(claims: readonly PipelineStatusClaim[]): { label: string; className: string } {
  const hasCancelled = claims.length > 0 && claims.every((s) => s.status === 'cancelled');
  const hasActive = claims.some((s) => s.status === 'pending' || s.status === 'claimed');
  const hasFailed = claims.some((s) => s.status === 'failed' || s.status === 'expired');

  if (hasCancelled) return { label: 'cancelled', className: 'border-zinc-700 bg-zinc-900 text-zinc-400' };
  if (hasActive) return { label: 'in progress', className: 'border-amber-800 bg-amber-950 text-amber-400' };
  if (hasFailed) return { label: 'failed', className: 'border-red-800 bg-red-950 text-red-400' };
  return { label: 'completed', className: 'border-green-800 bg-green-950 text-green-400' };
}

export function getLatestAttemptClaims<T extends AttemptClaim>(claims: readonly T[]): T[] {
  if (claims.length === 0) return [];
  const maxAttempt = Math.max(...claims.map((claim) => claim.attempt));
  return claims.filter((claim) => claim.attempt === maxAttempt);
}

export function getPipelineHeaderClaim<T extends HeaderClaim>(claims: readonly T[]): T | null {
  const latestAttemptClaims = getLatestAttemptClaims(claims);
  if (latestAttemptClaims.length === 0) return null;

  return [...latestAttemptClaims].reverse().find((claim) => claim.agent_id) ?? latestAttemptClaims[latestAttemptClaims.length - 1];
}
