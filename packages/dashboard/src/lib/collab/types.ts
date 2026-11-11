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
  userId: number | null;
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
  workspaceCapabilities?: { [workspaceId: string]: Capability[] };
  bootstrap?: { eligible: boolean; orgIds: string[] };
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
  hostName?: string | null;
  hostReachability?: HostReachability | null;
  hostLastSeenAt?: string | null;
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

export interface CollabEvent {
  eventId: string;
  projectId: string;
  taskId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface PendingRequest {
  requestId: string;
  kind: 'permission' | 'question';
  promptText: string;
  choices?: { id: string; label: string }[];
  expiresAt: string | null;
}

export interface ClaimExecutionBadge {
  id: number;
  taskId: string;
  claimType: string;
  attempt: number;
  status: string;
  rootClaimId: number;
  createdAt: string;
  completedAt: string | null;
}

export interface ClaimExecution extends ClaimExecutionBadge {
  projectId: string;
  repo: string;
  prNumber: number | null;
  sessionId: number | null;
  payload: Record<string, unknown>;
  headSha: string | null;
}

export interface ClaimExecutionEvent {
  seq: number;
  kind: string;
  payload: unknown;
  createdAt: string;
}

export interface ClaimExecutionRequest {
  requestKey: string;
  kind: 'permission' | 'elicitation';
  payload: unknown;
  status: 'open' | 'answer_queued' | 'resolved' | 'uncertain' | 'cancelled';
  createdAt: string;
  resolvedAt: string | null;
}

export interface StartClaimExecutionResult {
  claim: ClaimExecution | ClaimExecutionBadge;
  created: boolean;
}

export interface SubmitClaimCommandResult {
  commandId: number | null;
  kind: 'prompt' | 'cancel' | 'permission' | 'elicitation';
  status: string;
  created: boolean;
}
