/** Capability vocabulary and system role presets (contract: fixed lists). */
export const COLLAB_CAPABILITIES = [
  'task.read',
  'task.write',
  'comment.write',
  'internal.read',
  'run.start',
  'run.steer',
  'run.cancel',
  'delivery.accept',
  'project.admin',
  'membership.admin',
] as const;

export type CollabCapability = (typeof COLLAB_CAPABILITIES)[number];

export type SystemRolePreset = { name: string; capabilities: readonly CollabCapability[] };

export const SYSTEM_ROLE_PRESETS: readonly SystemRolePreset[] = [
  { name: 'viewer', capabilities: ['task.read'] },
  { name: 'collaborator', capabilities: ['task.read', 'task.write', 'comment.write'] },
  {
    name: 'reviewer',
    capabilities: ['task.read', 'task.write', 'comment.write', 'delivery.accept'],
  },
  {
    name: 'operator',
    capabilities: [
      'task.read',
      'task.write',
      'comment.write',
      'internal.read',
      'run.start',
      'run.steer',
      'run.cancel',
    ],
  },
  {
    name: 'manager',
    capabilities: [
      'task.read',
      'task.write',
      'comment.write',
      'internal.read',
      'run.start',
      'run.steer',
      'run.cancel',
      'delivery.accept',
      'project.admin',
      'membership.admin',
    ],
  },
];
