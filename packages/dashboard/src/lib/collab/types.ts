/**
 * Client-side view of the shared collaboration contract (camelCase wire fields).
 *
 * These mirror the shapes A persists and returns; at integration they must be
 * replaced by type-only imports from `@fluent-flow/db` (A owns the Zod
 * definitions) so drift cannot hide. No runtime values here — types only, so
 * nothing database-adjacent can enter the client bundle.
 */

export type TaskStatus = 'backlog' | 'ready' | 'in_progress' | 'review' | 'done' | 'cancelled';
export type ExecutionStage = 'design' | 'development' | 'test' | 'in_review';
export type RunState =
  | 'queued'
  | 'launching'
  | 'running'
  | 'needs_input'
  | 'idle'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'reconciling';
export type HostReachability = 'online' | 'stale' | 'offline';
export type Visibility = 'client' | 'internal';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export type Capability =
  | 'task.read'
  | 'task.write'
  | 'comment.write'
  | 'internal.read'
  | 'run.start'
  | 'run.steer'
  | 'run.cancel'
  | 'delivery.accept'
  | 'project.admin'
  | 'membership.admin';

export interface Principal {
  id: string;
  displayName: string;
  email: string | null;
  legacyUserId: number | null;
  disabledAt: string | null;
  sessionVersion: number;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface ExecutionDefaults {
  mappingId: string;
  profileId: string;
  model: string | null;
  instructions: string;
  summary: { enabled: boolean; profileId: string | null; model: string | null };
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  boardVersion: number;
  executionDefaults: ExecutionDefaults | null;
}

export interface MeCapabilities {
  [projectId: string]: Capability[];
}

export interface MeResponse {
  principal: Principal;
  workspaces: (Workspace & { projects: Project[] })[];
  capabilities: MeCapabilities;
  /** Workspace-scope capabilities only (never inferred from project roles). */
  workspaceCapabilities?: { [workspaceId: string]: Capability[] };
  /** Authoritative bootstrap eligibility from the legacy DB. */
  bootstrap?: { eligible: boolean; legacyOrgIds: string[] };
}

export interface Role {
  id: string;
  scopeId: string;
  name: string;
  capabilities: Capability[];
}

export interface Member {
  id?: string;
  projectId?: string | null;
  principalId: string;
  displayName: string;
  email: string | null;
  roleId: string;
  roleName: string;
  version: number;
}

export interface Invitation {
  id: string;
  email: string;
  roleId: string;
  expiresAt: string;
  /** One-time secret; only present in the authorized creation response. */
  url?: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assigneeId: string | null;
  /** Server-side display projection of the assignee (coordinated with A; absent until shipped). */
  assigneeName?: string | null;
  version: number;
  position: string;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskExecution {
  latestRun: Run | null;
  hostReachability: HostReachability | null;
  progress: string | null;
  attentionCount: number;
}

export interface Criterion {
  id: string;
  taskId: string;
  text: string;
  state: 'open' | 'met' | 'waived';
  reason: string | null;
  version: number;
}

export interface Comment {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  body: string;
  visibility: Visibility;
  createdAt: string;
}

export interface Run {
  id: string;
  taskId: string;
  hostId: string;
  mappingId: string;
  profileId: string;
  model: string | null;
  state: RunState;
  stage: ExecutionStage;
  version: number;
  createdAt: string;
  workspaceId: string | null;
  lastObservedAt: string | null;
  headCommit: string | null;
  retryOfRunId: string | null;
  errorCode: string | null;
  /** Intended-host display projection (coordinated with A; absent until shipped). */
  hostName?: string | null;
  hostReachability?: HostReachability | null;
  hostLastSeenAt?: string | null;
}

export interface Session {
  id: string;
  runId: string;
  paseoAgentId: string | null;
  providerSessionId: string | null;
  title: string;
  role: 'work' | 'summary';
  state: RunState;
  lastObservedAt: string | null;
  timelineEpoch: string | null;
  timelineSeq: string | null;
  capabilities: Record<string, boolean>;
}

export interface TimelineEntry {
  eventId: string;
  kind: string;
  payload: Record<string, unknown>;
  observedAt: string;
}

export interface Command {
  id: string;
  runId: string;
  sessionId: string | null;
  kind:
    | 'launch'
    | 'create_session'
    | 'prompt'
    | 'permission'
    | 'cancel'
    | 'summarize'
    | 'artifact_read'
    | 'wrapup_preflight'
    | 'wrapup';
  state: string;
  payload: Record<string, unknown>;
  errorCode: string | null;
  createdAt: string;
}

export interface Check {
  id: string;
  taskId: string;
  name: string;
  command: string;
  visibility: Visibility;
  version: number;
}

export interface CheckEvidence {
  id: string;
  checkId: string;
  runId: string | null;
  sessionId: string | null;
  commit: string | null;
  dirty: boolean | null;
  status: 'passed' | 'failed' | 'not_run';
  exitCode: number | null;
  observedAt: string;
  outputArtifactId: string | null;
  provenance: 'human' | 'agent' | 'runner';
  actorId: string;
  /** Derived server-side: evidence commit differs from deliverable head or the definition changed. */
  stale?: boolean;
  staleReason?: string | null;
}

export interface Artifact {
  id: string;
  taskId: string;
  runId: string | null;
  sessionId: string | null;
  direction: 'input' | 'output';
  kind: 'file' | 'url' | 'text';
  name: string;
  visibility: Visibility;
  provenance: 'human' | 'agent' | 'runner';
  ownerId: string;
  version: number;
  mediaType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  reference: string | null;
}

export interface Idea {
  id: string;
  version: number;
  provenance: 'human' | 'agent' | 'runner';
  conversionTargetTaskId: string | null;
  conversionCommandId: string | null;
  conversionSessionId: string | null;
  sourceTaskId: string;
  runId: string | null;
  sessionId: string | null;
  title: string;
  body: string;
  status: 'inbox' | 'converted' | 'dismissed';
  conversionTargetId: string | null;
  visibility: Visibility;
  authorId: string;
  createdAt: string;
}

export interface Summary {
  id: string;
  provenance: 'human' | 'agent' | 'runner';
  runId: string;
  sessionId: string | null;
  body: string;
  visibility: Visibility;
  model: string | null;
  sourceCursor: string | null;
  createdAt: string;
  authorId: string;
}

export interface AttentionItem {
  id: string;
  taskId: string;
  projectId: string;
  kind: 'question' | 'permission' | 'error' | 'unread' | 'attention';
  title: string;
  detail: string | null;
  createdAt: string;
  sessionId: string | null;
  requestId: string | null;
}

export interface Host {
  id: string;
  name: string;
  reachability: HostReachability;
  lastHeartbeatAt: string | null;
  revokedAt: string | null;
}

/** One-time enrollment response; never used as a stored/listed host. */
export interface CreatedExecutionHost {
  id: string;
  name: string;
  token: string;
}

export interface HostCatalog {
  hostId: string;
  repositories: { key: string }[];
  profiles: {
    id: string;
    name: string;
    provider: string;
    model: string | null;
    modeId: string | null;
    thinkingOptionId: string | null;
  }[];
}

export interface Mapping {
  id: string;
  projectId: string;
  hostId: string;
  repositoryKey: string;
  profileIds: string[];
  defaultProfileId: string;
  baseRef: string | null;
  /** Operator-authorized catalog projection (coordinated with A; absent until shipped). */
  hostName?: string | null;
  hostReachability?: 'online' | 'stale' | 'offline' | null;
  hostLastSeenAt?: string | null;
  profiles?: { id: string; name: string; provider: string; model: string | null }[];
  allowedModels?: string[] | null;
}

export interface DeliverySnapshot {
  id: string;
  taskId: string;
  note: string;
  artifactIds: string[];
  checkEvidenceIds: string[];
  openItemIds: string[];
  createdAt: string;
  createdBy: string;
}

export interface TaskDecision {
  id: string;
  taskId: string;
  decision: 'accept' | 'cancel' | 'reopen';
  note: string | null;
  acknowledgedOpenItemIds: string[];
  deliveryId: string | null;
  taskVersion: number;
  decidedByPrincipalId: string;
  reviewSnapshot: {
    deliveryId: string;
    runId: string | null;
    headCommit: string | null;
    dirty: boolean | null;
    evidenceRevision: string;
  } | null;
  createdAt: string;
}

export interface InsightsResponse {
  range: { from: string; to: string };
  tasks: { createdCount: number; acceptedCount: number };
  runs: { totalCount: number; failedCount: number };
  usage: {
    available: boolean;
    reason: string | null;
    tokensIn: number | null;
    tokensOut: number | null;
    costUsd: number | null;
    coverage: {samples:number;tokensIn:number;tokensOut:number;costUsd:number};
  };
}

export interface WorkpadPlanView {
  id: string;
  taskId: string;
  runId: string | null;
  sessionId: string | null;
  items: { text: string; status: 'pending' | 'in_progress' | 'completed' }[];
  provenance: 'agent' | 'human';
  createdAt: string;
}

export interface OpenQuestionView {
  id: string;
  taskId: string;
  runId: string | null;
  sessionId: string | null;
  text: string;
  answer: string | null;
  state: 'open' | 'resolved' | 'dismissed';
  provenance: 'agent' | 'human';
  version: number;
  createdAt: string;
}

/** SSE event envelope delivered on GET /events. */
export interface CollabEvent {
  eventId: string;
  projectId: string;
  taskId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * Authoritative pending question/permission request for a session (A-owned
 * shape proposal under coordination; B renders defensively until bound).
 */
export interface PendingRequest {
  requestId: string;
  kind: 'permission' | 'question';
  promptText: string;
  choices?: { id: string; label: string }[];
  expiresAt: string | null;
}
