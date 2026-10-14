type StageConfig = { label: string; color: string };

const stageConfig: Record<string, StageConfig> = {
  spec: { label: 'Spec', color: 'emerald' },
  build: { label: 'Build', color: 'amber' },
  review: { label: 'Review', color: 'violet' },
  review_fix: { label: 'Review Fix', color: 'indigo' },
  test_verify: { label: 'Test Verify', color: 'cyan' },
  verify: { label: 'Verify', color: 'sky' },
  security_review: { label: 'Security', color: 'rose' },
};

const verifyStageConfig: Record<string, StageConfig> = {
  red: { label: 'Verify Red', color: 'red' },
  green: { label: 'Verify Green', color: 'green' },
};

export function getStageConfig(claimType: string, phase?: string | null): StageConfig {
  const normalizedPhase = phase?.toLowerCase();
  if (claimType === 'verify' && normalizedPhase) {
    return verifyStageConfig[normalizedPhase] ?? stageConfig.verify;
  }
  return stageConfig[claimType] ?? { label: claimType, color: 'zinc' };
}

export const statusIcons: Record<string, string> = {
  completed: '\u2713',
  claimed: '\u27F3',
  pending: '\u23F3',
  failed: '\u2717',
  expired: '\u2717',
  cancelled: '\u2717',
};

export function formatDuration(start: string | Date | null, end: string | Date | null): string {
  if (!start || !end) return '';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
