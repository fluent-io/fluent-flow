/**
 * Collaboration identity facade — the A/B identity service exports named in
 * docs/plans/2026-10-19-collaborative-contracts.md. Server-only: never import
 * from a client bundle.
 */
export { signCollaborationActor, verifyCollaborationActor, CollabAssertionError } from './auth.js';
export type { CollabActor } from './auth.js';
export { createCollabProjectToken,listCollabProjectTokens,revokeCollabProjectToken,authenticateCollabToken,getAgentReportingTask } from './tokens.js';
export type { CollabTokenContext } from './tokens.js';
export {recordAgentProgress} from './tokens.js';
export {createCollabDeliveryLink,listCollabDeliveryLinks} from './delivery-links.js';

export { CollabServiceError, CollabRateLimitError } from './errors.js';
export { COLLAB_CAPABILITIES, SYSTEM_ROLE_PRESETS } from './capabilities.js';
export type { CollabCapability, SystemRolePreset } from './capabilities.js';
export {
  taskStatusSchema,
  taskPrioritySchema,
  visibilitySchema,
  executionStageSchema,
  runStateSchema,
  hostReachabilitySchema,
  collabTaskSchema,
} from './schemas.js';
export type {
  TaskStatus,
  TaskPriority,
  Visibility,
  ExecutionStage,
  RunState,
  HostReachability,
  CollabTask,
} from './schemas.js';

export {
  ensureGithubPrincipal,
  getCollabPrincipal,
  requireCurrentPrincipal,
} from './principals.js';
export type { CollabPrincipal } from './principals.js';

export {
  authenticateCollabPassword,
  hashPassword,
  verifyPassword,
} from './passwords.js';

export {
  createCollabInvitation,
  acceptCollabInvitation,
  listCollabInvitations,
  revokeCollabInvitation,
} from './invitations.js';

export {
  getCollabBootstrapEligibility,
  bootstrapCollaborationWorkspace,
  createCollabProject,
  updateProjectExecutionDefaults,
  getPrincipalMeProfile,
  createWorkspaceRole,
  listWorkspaceRoles,
} from './workspaces.js';
export type {
  CollabProject,
  MeProject,
  MeWorkspace,
  MeProfile,
} from './workspaces.js';

export {
  getProjectCapabilities,
  getWorkspaceCapabilities,
  requireCapabilities,
  authorize,
} from './authorize.js';

export {
  addCollabMember,
  updateCollabMemberRole,
  removeCollabMember,
  listCollabMembers,
  listCollabAssignees,
} from './memberships.js';
export type { CollabMembership } from './memberships.js';

export {
  isInternalAdmin,
  createExecutionHost,
  revokeExecutionHost,
  createProjectHostMapping,
  listProjectHostMappings,
  listExecutionHosts,
} from './hosts.js';
export type { ExecutionHost, ProjectHostMapping, ExecutionHostSummary } from './hosts.js';

export {
  startCollabRun,
  getCollabRun,
  listCollabRuns,
  updateRunStage,
  createRunSession,
  submitSessionCommand,
  getConnectorCommand,
  getSessionPendingRequest,
  queueRunCommand,
  queueArtifactRead,
  getSessionTimeline,
} from './runs.js';

export { createCollabComment, listCollabComments } from './comments.js';
export type { CollabComment } from './comments.js';

export { listTaskEvents, markTaskRead, listAttention } from './events.js';
export type { TaskEvent } from './events.js';
export type { Run, CollabSession, StartRunResult, PendingRequest } from './runs.js';

export {
  REPORTING_CAPABILITIES,
  deriveReportingCredential,
  ensureReportingBinding,
  authenticateAgentToken,
  reportingServerKey,
} from './runs.js';
export type { ReportingCapability, AgentReportingContext } from './runs.js';

export {
  authenticateHost,
  registerConnector,
  heartbeatConnector,
  pollConnectorCommands,
  ackConnectorCommand,
  submitConnectorObservations,
  reconcileConnectorCommand,
} from './connector.js';
export type { ConnectorRegistration, ConnectorCommand } from './connector.js';

export {
  createCollabTask,
  listCollabTasks,
  getCollabTask,
  moveCollabTask,
  updateCollabTask,
  compactLane,
  nextTailRank,
  betweenRanks,
  authorizedProjectIds,
} from './tasks.js';
export { enforceRateLimitBucket, rateLimitBucket } from './rate-limit.js';
