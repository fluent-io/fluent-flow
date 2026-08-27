import { eq } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import { resolveRepoConfig } from '../db/repo-configs.js';
import logger from '../logger.js';

const { agentClaims } = schema;

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const CONTROL_RE = /[\x00-\x1f]/g;
const TOKEN_RE = /x-access-token:[^@\s]+@/gi;
const PATH_CONTROL_RE = /[\x00-\x1f]/g;

function sanitize(text = '') {
  return String(text)
    .replace(ANSI_RE, '')
    .replace(CONTROL_RE, '')
    .replace(TOKEN_RE, 'x-access-token:***@')
    .trim();
}

function truncate(text, max = 200) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeAnnotationPath(input) {
  if (!input) return undefined;
  const cleaned = String(input)
    .replace(PATH_CONTROL_RE, '')
    .replace(/\\/g, '/')
    .trim();
  if (!cleaned || cleaned.startsWith('/') || cleaned.includes('..')) return undefined;
  const normalized = cleaned.replace(/^(\.\/)+/, '');
  return normalized || undefined;
}

/**
 * Hook called when a claim is dispatched (queued for an agent).
 * Creates a check run and stores the external id on the claim.
 *
 * Verify claims use the sync path to get the real GitHub check-run id.
 */
export async function onClaimDispatched(client, claim) {
  const { repo, head_sha, claim_type, id, installation_id } = claim;
  const [owner, repoName] = repo.split('/');
  const input = {
    name: `Fluent Flow — ${claim_type}`,
    head_sha,
    status: 'queued',
  };

  const checkRun = claim_type === 'verify'
    ? await client.createCheckRunSync(
      { owner, repo: repoName },
      input,
      installation_id != null ? { installation_id, claim_id: id } : { claim_id: id }
    )
    : await client.createCheckRun({ owner, repo: repoName }, input, { claim_id: id });

  const checkRunId = checkRun?.id;
  if (checkRunId && id) {
    await db.update(agentClaims).set({ checkRunExternalId: checkRunId }).where(eq(agentClaims.id, id));
  }

  logger.info({ msg: 'onClaimDispatched', claimId: id, checkRunId });
  return { ...claim, check_run_external_id: checkRunId };
}

/**
 * Hook called when an agent picks up (starts) a claim.
 */
export async function onClaimStarted(client, claim) {
  const { repo, check_run_external_id } = claim;
  if (!check_run_external_id) return;

  const [owner, repoName] = repo.split('/');

  await client.updateCheckRun({ owner, repo: repoName }, check_run_external_id, {
    status: 'in_progress',
    started_at: new Date().toISOString(),
  });

  logger.info({ msg: 'onClaimStarted', claimId: claim.id, checkRunId: check_run_external_id });
}

function buildConfigSnapshot(repo) {
  return resolveRepoConfig(repo)
    .then((config) => ({
      title: 'Effective Config',
      summary: 'Config snapshot at time of resolution',
      text: `\`\`\`json\n${JSON.stringify({
        default_agent: config.default_agent ?? null,
        claim_types: config.claim_types ?? null,
        review_model: config.review_model ?? null,
      }, null, 2)}\n\`\`\``,
    }))
    .catch((err) => {
      logger.warn({ msg: 'buildConfigSnapshot failed', repo, error: err.message });
      return undefined;
    });
}

function formatRequirementLine(req) {
  const id = sanitize(req.id ?? 'REQ-?');
  const title = truncate(sanitize(req.title ?? req.text ?? req.message ?? 'requirement'), 120);
  const passCount = req.pass_count ?? req.passed ?? req.green ?? 0;
  const failCount = req.fail_count ?? req.failed ?? req.red ?? 0;
  return truncate(`${id} ${title} → red ${failCount ? '✓' : '✗'} green ${passCount ? '✓' : '✗'}`, 200);
}

export function renderMatrixSummary(verification = {}) {
  const matrix = verification.matrix ?? {};
  const requirements = Array.isArray(matrix.requirements) ? matrix.requirements : [];
  const suite = matrix.suite ?? {};
  const annotations = [];
  const lines = [];

  for (const req of requirements) {
    lines.push(formatRequirementLine(req));
    if (req.status === 'FAIL') {
      const path = normalizeAnnotationPath(req.file ?? req.path);
      if (!path) continue;
      annotations.push({
        path,
        start_line: req.start_line ?? 1,
        end_line: req.end_line ?? req.start_line ?? 1,
        annotation_level: 'failure',
        message: truncate(sanitize(req.message ?? req.title ?? req.text ?? 'Requirement failed'), 200),
        title: truncate(sanitize(req.id ?? 'Requirement failed'), 50),
      });
    }
  }

  if (verification.outcome === 'SKIPPED') lines.push('SKIPPED: verification was skipped.');
  if (verification.outcome === 'TAMPERED') lines.push('TAMPERED: verifier integrity checks failed.');

  lines.push(`Suite totals: ${suite.passed ?? 0} passed, ${suite.failed ?? 0} failed, ${suite.skipped ?? 0} skipped, ${suite.flaky ?? 0} flaky of ${suite.total ?? requirements.length}.`);

  return {
    title: 'Verification Matrix',
    summary: sanitize(lines.join('\n')),
    annotations: annotations.slice(0, 50),
  };
}

export async function onClaimResolved(client, claim, { conclusion, output } = {}) {
  const { repo, check_run_external_id } = claim;
  if (!check_run_external_id) return;

  const [owner, repoName] = repo.split('/');
  const resolvedOutput = output ?? await buildConfigSnapshot(repo);

  await client.updateCheckRun({ owner, repo: repoName }, check_run_external_id, {
    status: 'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    ...(resolvedOutput && { output: resolvedOutput }),
  });

  logger.info({ msg: 'onClaimResolved', claimId: claim.id, checkRunId: check_run_external_id, conclusion });
}
