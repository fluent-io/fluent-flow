import type { PipelineDetailClaim } from '@fluent-flow/db';

export type PipelineVerificationResult = NonNullable<PipelineDetailClaim['verification_result']>;
export type VerificationClaim = PipelineDetailClaim;

export type MatrixRequirement = {
  finding: string;
  requirement: string;
  tests: string[];
  status: string;
  redStatus: string;
  greenStatus: string;
  flaky: boolean;
};

export type ListRow = {
  label: string;
  detail: string;
  message: string;
};

export type ArtifactRow = {
  label: string;
  sha: string;
};

export type SuiteTotals = {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
};

export type VerificationCardModel = {
  result: PipelineVerificationResult | null;
  phase: string;
  framework: string;
  outcome: string | null | undefined;
  suite: SuiteTotals;
  requirements: MatrixRequirement[];
  warnings: ListRow[];
  flakes: ListRow[];
  unverifiedFindings: string[];
  artifacts: ArtifactRow[];
  hashes: ArtifactRow[];
};

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function displayValue(value: unknown): string {
  return stringValue(value) ?? '—';
}

function upperValue(value: unknown): string {
  return (stringValue(value) ?? '—').toUpperCase();
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function getRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return getArray(value)
    .map((entry) => {
      const row = getRecord(entry);
      return stringValue(entry) ?? stringValue(row.path ?? row.file ?? row.id ?? row.name);
    })
    .filter((entry): entry is string => Boolean(entry));
}

function getPayload(claim: VerificationClaim): Record<string, unknown> {
  return getRecord(claim.payload);
}

function getPhase(claim: VerificationClaim, result: PipelineVerificationResult | null): string {
  return displayValue(result?.phase ?? getPayload(claim).phase);
}

function getMatrix(result: PipelineVerificationResult | null): Record<string, unknown> {
  return getRecord(result?.matrix);
}

function getSuite(matrix: Record<string, unknown>): SuiteTotals {
  const suite = getRecord(matrix.suite);
  return {
    total: numberValue(suite.total),
    passed: numberValue(suite.passed),
    failed: numberValue(suite.failed),
    flaky: numberValue(suite.flaky),
    skipped: numberValue(suite.skipped),
  };
}

function getNestedString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const direct = stringValue(record[key]);
    if (direct) return direct;
  }
  return null;
}

function getRequirementRows(matrix: Record<string, unknown>): MatrixRequirement[] {
  return getArray(matrix.requirements).map((entry) => {
    const row = getRecord(entry);
    const requirement = getRecord(row.requirement);
    const finding = getRecord(row.finding ?? row.source_finding);
    const red = getRecord(row.red);
    const green = getRecord(row.green);
    const directTests = stringArray(row.tests);
    const tests = directTests.length > 0 ? directTests : stringArray(requirement.tests);

    return {
      finding: getNestedString(row, ['source_finding_id', 'finding_id']) ?? getNestedString(finding, ['id', 'title']) ?? '—',
      requirement: getNestedString(row, ['id', 'requirement_id']) ?? getNestedString(requirement, ['id', 'title']) ?? '—',
      tests,
      status: upperValue(row.status),
      redStatus: upperValue(red.status ?? row.red_status ?? (green.status ? null : row.status)),
      greenStatus: upperValue(green.status ?? row.green_status),
      flaky: Boolean(green.flaky ?? red.flaky ?? row.flaky),
    };
  });
}

function getWarnings(matrix: Record<string, unknown>): ListRow[] {
  return getArray(matrix.warnings).map((entry, index) => {
    const row = getRecord(entry);
    return {
      label: displayValue(row.file ?? row.path ?? `warning-${index + 1}`),
      detail: upperValue(row.status),
      message: displayValue(row.message ?? row.reason),
    };
  });
}

function getFlakes(matrix: Record<string, unknown>, requirements: MatrixRequirement[]): ListRow[] {
  const explicit = getArray(matrix.flakes).map((entry, index) => {
    const row = getRecord(entry);
    return {
      label: displayValue(row.file ?? row.path ?? row.id ?? `flake-${index + 1}`),
      detail: upperValue(row.status ?? row.phase),
      message: displayValue(row.message ?? row.reason),
    };
  });

  const requirementFlakes = requirements
    .filter((requirement) => requirement.flaky)
    .map((requirement) => ({
      label: requirement.requirement,
      detail: requirement.greenStatus,
      message: requirement.tests.length > 0 ? requirement.tests.join(', ') : 'Requirement was flaky during verification',
    }));

  return [...explicit, ...requirementFlakes];
}

function getUnverifiedFindings(claim: VerificationClaim, matrix: Record<string, unknown>): string[] {
  const payload = getPayload(claim);
  const matrixFindings = stringArray(matrix.unverified_findings ?? matrix.unverifiedFindings);
  if (matrixFindings.length > 0) return matrixFindings;
  return stringArray(payload.unverified_findings ?? payload.unverifiedFindings);
}

function getHashRows(result: PipelineVerificationResult | null): ArtifactRow[] {
  if (!result) return [];
  const resultRecord = getRecord(result);
  return getArray(result.test_hashes ?? resultRecord.testHashes).map((entry, index) => {
    const direct = stringValue(entry);
    const row = getRecord(entry);
    return {
      label: direct ? `hash-${index + 1}` : displayValue(row.path ?? row.file ?? `hash-${index + 1}`),
      sha: direct ?? displayValue(row.sha256 ?? row.sha ?? row.hash),
    };
  }).filter((row) => row.sha !== '—');
}

function addArtifact(rows: ArtifactRow[], seen: Set<string>, label: string, value: unknown) {
  const sha = stringValue(value);
  if (!sha || seen.has(`${label}:${sha}`)) return;
  seen.add(`${label}:${sha}`);
  rows.push({ label, sha });
}

function getArtifactRows(result: PipelineVerificationResult | null, matrix: Record<string, unknown>): ArtifactRow[] {
  const rows: ArtifactRow[] = [];
  const seen = new Set<string>();
  const resultRecord = getRecord(result);
  const artifact = getRecord(matrix.artifact);

  addArtifact(rows, seen, 'Artifact SHA', result?.artifact_sha ?? resultRecord.artifactSha);
  addArtifact(rows, seen, 'Red base SHA', result?.red_base_sha ?? resultRecord.redBaseSha);
  addArtifact(rows, seen, 'Green SHA', result?.green_sha ?? resultRecord.greenSha);
  addArtifact(rows, seen, 'Red artifact', artifact.red);
  addArtifact(rows, seen, 'Green artifact', artifact.green);

  return rows;
}

export function commitHref(repo: string, sha: string): string | null {
  return repo.includes('/') && /^[0-9a-f]{7,40}$/i.test(sha) ? `https://github.com/${repo}/commit/${sha}` : null;
}

export function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

export function getVerificationCardModel(claim: VerificationClaim): VerificationCardModel {
  const result = claim.verification_result ?? null;
  const matrix = getMatrix(result);
  const requirements = getRequirementRows(matrix);

  return {
    result,
    phase: getPhase(claim, result),
    framework: displayValue(result?.framework),
    outcome: result?.outcome,
    suite: getSuite(matrix),
    requirements,
    warnings: getWarnings(matrix),
    flakes: getFlakes(matrix, requirements),
    unverifiedFindings: getUnverifiedFindings(claim, matrix),
    artifacts: getArtifactRows(result, matrix),
    hashes: getHashRows(result),
  };
}
