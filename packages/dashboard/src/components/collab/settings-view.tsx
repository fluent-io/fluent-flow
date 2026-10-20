'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { collabFetch, collabFetchAll, ApiError } from '@/lib/collab/api';
import { LatestRequest } from '@/lib/collab/live';
import { capabilitiesFor, useMe, workspaceCapabilitiesFor } from '@/lib/collab/use-me';
import type {
  Host,
  CreatedExecutionHost,
  HostCatalog,
  InsightsResponse,
  Invitation,
  Mapping,
  Member,
  MeResponse,
  Project,
  Role,
  Capability,
  Workspace,
} from '@/lib/collab/types';

const CAPABILITIES: Capability[] = [
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
];

export function SettingsView() {
  const { me, reload } = useMe();
  const [scope, setScope] = useState<{ kind: 'workspace' | 'project'; id: string } | null>(null);

  const workspaceOptions = me?.workspaces ?? [];
  const projectOptions = useMemo(
    () => (me?.workspaces ?? []).flatMap((w) => w.projects.map((p) => ({ ...p, workspaceName: w.name }))),
    [me],
  );

  useEffect(() => {
    if (!scope && workspaceOptions.length > 0) {
      setScope({ kind: 'workspace', id: workspaceOptions[0].id });
    }
  }, [scope, workspaceOptions]);

  if (!me) return <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <h1 className="text-lg font-semibold">Settings</h1>

      <WorkspacePanel me={me} reload={reload} />

      <section aria-label="Scope selection" className="flex flex-wrap gap-2">
        <select
          aria-label="Settings scope"
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          value={scope ? `${scope.kind}:${scope.id}` : ''}
          onChange={(e) => {
            const [kind, id] = e.target.value.split(':');
            setScope(kind === 'project' ? { kind: 'project', id } : { kind: 'workspace', id });
          }}
        >
          {workspaceOptions.map((w) => (
            <option key={`workspace:${w.id}`} value={`workspace:${w.id}`}>
              Workspace · {w.name}
            </option>
          ))}
          {projectOptions.map((p) => (
            <option key={`project:${p.id}`} value={`project:${p.id}`}>
              Project · {p.name} ({p.workspaceName})
            </option>
          ))}
        </select>
      </section>

      {scope?.kind === 'workspace' ? <WorkspaceScopedPanels key={scope.id} me={me} workspaceId={scope.id} reload={reload} /> : null}
      {scope?.kind === 'project' ? (
        <ProjectScopedPanels key={scope.id} me={me} project={projectOptions.find((p) => p.id === scope.id) ?? null} reload={reload} />
      ) : null}
      {scope?.kind === 'project' ? <InsightsPanel projectId={scope.id} /> : null}
    </div>
  );
}

function WorkspacePanel({ me, reload }: { me: MeResponse; reload: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const eligible = me.bootstrap?.eligible ?? false;
  const orgIds = me.bootstrap?.legacyOrgIds ?? [];

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await collabFetch('/workspaces', {
        method: 'POST',
        body: { name, legacyOrgId: orgIds.length > 1 ? orgId : orgIds[0] },
      });
      setName('');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError && (err.status === 403 || err.status === 422) ? 'Only an internal organization admin can create a client workspace.' : err instanceof Error ? err.message : 'Could not create the workspace.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Client workspaces" className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium">Client workspaces</h2>
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {me.workspaces.length === 0 ? <li className="text-xs text-muted-foreground">No workspaces yet.</li> : null}
        {me.workspaces.map((w) => (
          <li key={w.id} className="flex items-center justify-between rounded border border-border bg-background px-2.5 py-1.5">
            <span>{w.name}</span>
            <span className="text-xs text-muted-foreground">{w.projects.length} project(s)</span>
          </li>
        ))}
      </ul>
      {eligible ? (
        <form onSubmit={createWorkspace} className="mt-3 flex flex-wrap gap-2">
          <Input placeholder="New client workspace name" value={name} onChange={(e) => setName(e.target.value)} required />
          {orgIds.length > 1 ? (
            <select aria-label="Organization" className="h-9 rounded-md border border-border bg-background px-2 text-sm" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              {orgIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          ) : null}
          <Button size="sm" type="submit" disabled={busy}>
            Create
          </Button>
        </form>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Client workspace creation requires an internal organization administrator.
        </p>
      )}
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

function WorkspaceScopedPanels({ me, workspaceId, reload }: { me: MeResponse; workspaceId: string; reload: () => Promise<void> }) {
  const caps = workspaceCapabilitiesFor(me, workspaceId);
  const workspaceName = me.workspaces.find((w) => w.id === workspaceId)?.name ?? '';

  const [projects, setProjects] = useState<Project[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);
  const canMembershipAdmin = workspaceCapabilitiesFor(me, workspaceId).includes('membership.admin');
  const scopedRequests = useRef(new LatestRequest());

  const loadScoped = useCallback(async () => {
    const signal = scopedRequests.current.begin();
    const results = await Promise.allSettled([
      collabFetch<Project[]>(`/workspaces/${workspaceId}/projects`,{signal}),
      canMembershipAdmin ? collabFetch<Role[]>(`/workspaces/${workspaceId}/roles`,{signal}) : Promise.resolve({data:[] as Role[]}),
      canMembershipAdmin ? collabFetchAll<Member>(`/workspaces/${workspaceId}/members`,{signal}) : Promise.resolve({data:[] as Member[],truncated:false}),
      canMembershipAdmin ? collabFetch<Invitation[]>(`/workspaces/${workspaceId}/invitations`,{signal}) : Promise.resolve({data:[] as Invitation[]}),
    ]);
    if (!scopedRequests.current.current(signal)) return;
    setProjects(results[0].status==='fulfilled'?results[0].value.data:[]);
    setRoles(results[1].status==='fulfilled'?results[1].value.data:[]);
    setMembers(results[2].status==='fulfilled'?results[2].value.data:[]);
    setInvitations(results[3].status==='fulfilled'?results[3].value.data:[]);
    setLoadError(results.some(result=>result.status==='rejected')?'Some workspace settings are unavailable.':results[2].status==='fulfilled'&&results[2].value.truncated?'Some members exceed the display limit.':null);
  }, [workspaceId, canMembershipAdmin]);

  useEffect(() => {
    void loadScoped();
    return () => scopedRequests.current.dispose();
  }, [loadScoped]);

  const canProjectAdmin = caps.includes('project.admin');

  return (
    <>
      {loadError ? <p role="alert" className="text-xs text-destructive">{loadError}</p> : null}
      <section aria-label="Projects" className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-medium">Projects in {workspaceName}</h2>
        <ProjectCreate projectId={null} workspaceId={workspaceId} canCreate={canProjectAdmin} onCreated={async () => { await loadScoped(); await reload(); }} />
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {projects.map((p) => (
            <li key={p.id} className="flex items-center justify-between rounded border border-border bg-background px-2.5 py-1.5">
              <span>{p.name}</span>
              {capabilitiesFor(me,p.id).includes('internal.read') ? <span className="text-xs text-muted-foreground">{p.executionDefaults ? 'execution configured' : 'execution not configured'}</span> : null}
            </li>
          ))}
        </ul>
      </section>

      {canMembershipAdmin ? (
        <MembersPanel
          scopePath={`workspaces/${workspaceId}`}
          members={members}
          roles={roles}
          invitations={invitations}
          inviteUrl={inviteUrl}
          setInviteUrl={setInviteUrl}
          onChanged={loadScoped}
        />
      ) : null}

      {canMembershipAdmin ? <RolesPanel scopePath={`workspaces/${workspaceId}`} roles={roles} allowedCapabilities={caps} onChanged={loadScoped} /> : null}
    </>
  );
}

function ProjectScopedPanels({ me, project, reload }: { me: MeResponse; project: (Project & { workspaceName?: string }) | null; reload: () => Promise<void> }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const scopedRequests = useRef(new LatestRequest());
  const caps = project ? capabilitiesFor(me, project.id) : [];
  const canMembershipAdmin = caps.includes('membership.admin');
  const canExecutionAdmin = caps.includes('project.admin') && caps.includes('internal.read');
  const canHostAdmin = canExecutionAdmin && me.bootstrap?.eligible === true;
  const projectId = project?.id;
  const workspaceId = project?.workspaceId;

  const loadScoped = useCallback(async () => {
    if (!projectId || !workspaceId) return;
    const signal = scopedRequests.current.begin();
    const results = await Promise.allSettled([
      canMembershipAdmin ? collabFetchAll<Member>(`/projects/${projectId}/members`,{signal}) : Promise.resolve({data:[] as Member[],truncated:false}),
      canMembershipAdmin ? collabFetch<Role[]>(`/workspaces/${workspaceId}/roles?projectId=${projectId}`,{signal}) : Promise.resolve({data:[] as Role[]}),
      canMembershipAdmin ? collabFetch<Invitation[]>(`/projects/${projectId}/invitations`,{signal}) : Promise.resolve({data:[] as Invitation[]}),
      canExecutionAdmin ? collabFetch<Mapping[]>(`/projects/${projectId}/mappings`,{signal}) : Promise.resolve({data:[] as Mapping[]}),
      canHostAdmin ? collabFetch<Host[]>('/hosts',{signal}) : Promise.resolve({data:[] as Host[]}),
    ]);
    if (!scopedRequests.current.current(signal)) return;
    setMembers(results[0].status==='fulfilled'?results[0].value.data:[]);
    setRoles(results[1].status==='fulfilled'?results[1].value.data:[]);
    setInvitations(results[2].status==='fulfilled'?results[2].value.data:[]);
    setMappings(results[3].status==='fulfilled'?results[3].value.data:[]);
    setHosts(results[4].status==='fulfilled'?results[4].value.data:[]);
    setLoadError(results.some(result=>result.status==='rejected')?'Some project settings are unavailable.':results[0].status==='fulfilled'&&results[0].value.truncated?'Some members exceed the display limit.':null);
  }, [projectId, workspaceId, canMembershipAdmin, canExecutionAdmin, canHostAdmin]);

  useEffect(() => {
    void loadScoped();
    return () => scopedRequests.current.dispose();
  }, [loadScoped]);

  if (!project) return null;

  return (
    <>
      {loadError ? <p role="alert" className="text-xs text-destructive">{loadError}</p> : null}
      {canExecutionAdmin ? <ExecutionDefaultsPanel project={project} mappings={mappings} onChanged={async () => { await loadScoped(); await reload(); }} /> : null}
      {canHostAdmin ? <MappingsPanel project={project} mappings={mappings} hosts={hosts} onChanged={loadScoped} /> : null}
      {canMembershipAdmin ? (
        <MembersPanel
          scopePath={`projects/${project.id}`}
          members={members}
          roles={roles}
          invitations={invitations}
          inviteUrl={inviteUrl}
          setInviteUrl={setInviteUrl}
          onChanged={loadScoped}
        />
      ) : null}
      {canMembershipAdmin ? <p className="text-xs text-muted-foreground">Role definitions are managed at workspace scope.</p> : null}
    </>
  );
}

function ProjectCreate({ projectId, workspaceId, canCreate, onCreated }: { projectId: string | null; workspaceId: string | null; canCreate: boolean; onCreated: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canCreate || projectId !== null) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await collabFetch(`/workspaces/${workspaceId}/projects`, { method: 'POST', body: { name } });
      setName('');
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the project.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 flex gap-2">
      <Input placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} required />
      <Button size="sm" type="submit" disabled={busy}>
        Create project
      </Button>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </form>
  );
}

function MembersPanel({
  scopePath,
  members,
  roles,
  invitations,
  inviteUrl,
  setInviteUrl,
  onChanged,
}: {
  scopePath: string;
  members: Member[];
  roles: Role[];
  invitations: Invitation[];
  inviteUrl: string | null;
  setInviteUrl: (url: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [expiresInHours, setExpiresInHours] = useState('72');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRoleId(current => roles.some(role => role.id === current) ? current : roles[0]?.id ?? '');
  }, [roles]);

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setInviteUrl(null);
    try {
      const result = await collabFetch<Invitation>(`/${scopePath}/invitations`, {
        method: 'POST',
        body: { email, roleId, expiresInHours: Number(expiresInHours) },
      });
      setEmail('');
      setInviteUrl(result.data.url ?? null);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the invitation.');
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(member: Member, newRoleId: string) {
    try {
      await collabFetch(`/${scopePath}/members/${member.principalId}`, {
        method: 'PATCH',
        body: { roleId: newRoleId, expectedVersion: member.version },
      });
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 422 ? 'At least one membership administrator must remain.' : err instanceof Error ? err.message : 'Could not change the role.');
    }
  }

  async function removeMember(member: Member) {
    try {
      await collabFetch(`/${scopePath}/members/${member.principalId}`, { method: 'DELETE' });
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 422 ? 'At least one membership administrator must remain.' : err instanceof Error ? err.message : 'Could not remove the member.');
    }
  }

  return (
    <section aria-label="Members" className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium">Members</h2>
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {members.map((member) => (
          <li key={member.id ?? `${member.projectId ?? 'workspace'}:${member.principalId}`} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-background px-2.5 py-1.5">
            <span>
              {member.displayName}
              <span className="ml-2 text-xs text-muted-foreground">{member.email}</span>
            </span>
            {scopePath.startsWith('projects/') && member.projectId === null ? <span className="text-xs text-muted-foreground">{member.roleName} · inherited from workspace</span> : (
            <span className="flex items-center gap-2">
              <select
                aria-label={`Role for ${member.displayName}`}
                className="h-7 rounded border border-border bg-background px-1.5 text-xs"
                value={member.roleId}
                onChange={(e) => void changeRole(member, e.target.value)}
              >
                {!roles.some(role => role.id === member.roleId) ? <option value={member.roleId} disabled>{member.roleName}</option> : null}
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
              <button className="text-xs text-muted-foreground hover:text-destructive" onClick={() => void removeMember(member)}>
                remove
              </button>
            </span>
            )}
          </li>
        ))}
      </ul>

      <h3 className="mt-4 text-sm font-medium">Invite a collaborator</h3>
      <p className="text-xs text-muted-foreground">
        The invitation link is shown once — copy it and share it privately. It works without a GitHub account.
      </p>
      <form onSubmit={invite} className="mt-2 flex flex-wrap gap-2">
        <Input className="w-56" type="email" placeholder="collaborator@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <select aria-label="Invitation role" className="h-9 rounded-md border border-border bg-background px-2 text-sm" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
        <select aria-label="Expires in" className="h-9 rounded-md border border-border bg-background px-2 text-sm" value={expiresInHours} onChange={(e) => setExpiresInHours(e.target.value)}>
          {['24', '72', '168'].map((h) => (
            <option key={h} value={h}>
              {h}h
            </option>
          ))}
        </select>
        <Button size="sm" type="submit" disabled={busy || !roleId}>
          Create invitation
        </Button>
      </form>
      {inviteUrl ? (
        <div className="mt-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs">
          <p className="font-medium">One-time invitation link (copy now, shown once):</p>
          <code className="mt-1 block break-all">{inviteUrl}</code>
        </div>
      ) : null}
      {invitations.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {invitations.length} pending invitation(s).
        </p>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

function RolesPanel({ scopePath, roles, allowedCapabilities, onChanged }: { scopePath: string; roles: Role[]; allowedCapabilities: string[]; onChanged: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<Capability>>(() => new Set(allowedCapabilities.includes('task.read') ? ['task.read'] : CAPABILITIES.filter(capability => allowedCapabilities.includes(capability)).slice(0, 1)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(capability: Capability) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(capability)) next.delete(capability);
      else next.add(capability);
      return next;
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await collabFetch(`/${scopePath}/roles`, {
        method: 'POST',
        body: { name, capabilities: [...selected] },
      });
      setName('');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the role.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Roles" className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium">Roles</h2>
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {roles.map((role) => (
          <li key={role.id} className="rounded border border-border bg-background px-2.5 py-1.5">
            <span className="font-medium">{role.name}</span>
            <span className="ml-2 text-xs text-muted-foreground">{role.capabilities.join(', ')}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
        <Input placeholder="Custom role name" value={name} onChange={(e) => setName(e.target.value)} required />
        <div className="flex flex-wrap gap-2 text-xs">
          {CAPABILITIES.filter(capability => allowedCapabilities.includes(capability)).map((capability) => (
            <label key={capability} className="flex items-center gap-1 rounded border border-border px-2 py-1">
              <input type="checkbox" checked={selected.has(capability)} onChange={() => toggle(capability)} />
              {capability}
            </label>
          ))}
        </div>
        <Button size="sm" type="submit" disabled={busy || selected.size === 0} className="self-start">
          Create role
        </Button>
      </form>
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

function ExecutionDefaultsPanel({ project, mappings, onChanged }: { project: Project; mappings: Mapping[]; onChanged: () => Promise<void> }) {
  const defaults = project.executionDefaults;
  const [mappingId, setMappingId] = useState(defaults?.mappingId ?? '');
  const [profileId, setProfileId] = useState(defaults?.profileId ?? '');
  const [model, setModel] = useState(defaults?.model ?? '');
  const [instructions, setInstructions] = useState(defaults?.instructions ?? '');
  const [summaryEnabled, setSummaryEnabled] = useState(defaults?.summary?.enabled ?? false);
  const [summaryProfileId, setSummaryProfileId] = useState(defaults?.summary?.profileId ?? '');
  const [summaryModel, setSummaryModel] = useState(defaults?.summary?.model ?? '');
  const selectedMapping = mappings.find(mapping => mapping.id === mappingId);
  const profiles = selectedMapping?.profiles ?? [];
  const workProfile = profiles.find(profile => profile.id === profileId);
  const summaryProfile = profiles.find(profile => profile.id === summaryProfileId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMappingId(defaults?.mappingId ?? '');
    setProfileId(defaults?.profileId ?? '');
    setModel(defaults?.model ?? '');
    setInstructions(defaults?.instructions ?? '');
    setSummaryEnabled(defaults?.summary?.enabled ?? false);
    setSummaryProfileId(defaults?.summary?.profileId ?? '');
    setSummaryModel(defaults?.summary?.model ?? '');
  }, [defaults, project.id]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await collabFetch(`/projects/${project.id}`, {
        method: 'PATCH',
        body: {
          expectedVersion: project.version,
          executionDefaults: {
            mappingId,
            profileId,
            model: model || null,
            instructions,
            summary: { enabled: summaryEnabled, profileId: summaryProfileId || null, model: summaryModel || null },
          },
        },
      });
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? 'This item changed. Refresh before saving.' : err instanceof Error ? err.message : 'Could not save execution defaults.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Execution defaults" className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium">Execution defaults for {project.name}</h2>
      <form onSubmit={save} className="mt-2 flex flex-col gap-2 text-sm">
        <label className="flex flex-col gap-1 text-xs">
          Repository mapping
          <select aria-label="Default mapping" className="h-8 rounded border border-border bg-background px-2 text-xs" value={mappingId} onChange={(e) => setMappingId(e.target.value)}>
            <option value="">Not set</option>
            {mappings.map((m) => (
              <option key={m.id} value={m.id}>
                {m.repositoryKey} · {m.hostName ?? 'execution host'}{m.hostReachability ? ` (${m.hostReachability})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Default agent profile
          <select aria-label="Default agent profile" className="h-8 rounded border border-border bg-background px-2 text-xs" value={profileId} required onChange={event => {setProfileId(event.target.value);setModel('');}}>
            <option value="">Choose a profile</option>
            {profileId && !workProfile ? <option value={profileId} disabled>{profileId} (unavailable)</option> : null}
            {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Default model override
          <select aria-label="Default model override" className="h-8 rounded border border-border bg-background px-2 text-xs" value={model} onChange={event => setModel(event.target.value)}>
            <option value="">Profile default</option>
            {model && model !== workProfile?.model ? <option value={model} disabled>{model} (unavailable)</option> : null}
            {workProfile?.model ? <option value={workProfile.model}>{workProfile.model}</option> : null}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Default instructions
          <textarea aria-label="Default instructions" className="min-h-[56px] rounded-md border border-border bg-background px-3 py-2 text-xs" maxLength={20000} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={summaryEnabled} onChange={(e) => setSummaryEnabled(e.target.checked)} />
          Enable run summaries
        </label>
        {summaryEnabled ? (
          <>
            <label className="flex flex-col gap-1 text-xs">
              Summary profile
              <select aria-label="Summary profile" className="h-8 rounded border border-border bg-background px-2 text-xs" value={summaryProfileId} required onChange={event => {setSummaryProfileId(event.target.value);setSummaryModel('');}}>
                <option value="">Choose a profile</option>
                {summaryProfileId && !summaryProfile ? <option value={summaryProfileId} disabled>{summaryProfileId} (unavailable)</option> : null}
                {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Summary model override
              <select aria-label="Summary model override" className="h-8 rounded border border-border bg-background px-2 text-xs" value={summaryModel} onChange={event => setSummaryModel(event.target.value)}>
                <option value="">Profile default</option>
                {summaryModel && summaryModel !== summaryProfile?.model ? <option value={summaryModel} disabled>{summaryModel} (unavailable)</option> : null}
                {summaryProfile?.model ? <option value={summaryProfile.model}>{summaryProfile.model}</option> : null}
              </select>
            </label>
          </>
        ) : null}
        <Button size="sm" type="submit" disabled={busy || !mappingId || !profileId} className="self-start">
          Save defaults
        </Button>
      </form>
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

function MappingsPanel({ project, mappings, hosts, onChanged }: { project: Project; mappings: Mapping[]; hosts: Host[]; onChanged: () => Promise<void> }) {
  const [hostId, setHostId] = useState('');
  const [repositoryKey, setRepositoryKey] = useState('');
  const [profileIds, setProfileIds] = useState('');
  const [defaultProfileId, setDefaultProfileId] = useState('');
  const [catalog, setCatalog] = useState<HostCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hostId && hosts.length > 0) setHostId(hosts[0].id);
  }, [hosts, hostId]);

  async function loadCatalog(id: string) {
    setCatalog(null);
    if (!id) return;
    try {
      const result = await collabFetch<HostCatalog>(`/hosts/${id}/catalog`);
      setCatalog(result.data);
    } catch {
      setCatalog(null);
    }
  }

  async function createHost(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await collabFetch<CreatedExecutionHost>('/hosts', {
        method: 'POST',
        body: { name: repositoryKey || 'execution host' },
      });
      window.prompt('Host enrollment token (copy now, shown once):', result.data.token);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not enroll the host.');
    } finally {
      setBusy(false);
    }
  }

  async function createMapping(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await collabFetch(`/projects/${project.id}/mappings`, {
        method: 'POST',
        body: {
          hostId,
          repositoryKey,
          profileIds: profileIds.split(',').map((s) => s.trim()).filter(Boolean),
          defaultProfileId: defaultProfileId || profileIds.split(',')[0]?.trim() || '',
        },
      });
      setRepositoryKey('');
      setProfileIds('');
      setDefaultProfileId('');
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? 'Host mapping needs an internal admin with project admin rights.' : err instanceof Error ? err.message : 'Could not create the mapping.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Hosts and repository mappings" className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium">Execution hosts and repository mappings</h2>
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {hosts.map((host) => (
          <li key={host.id} className="flex items-center justify-between rounded border border-border bg-background px-2.5 py-1.5">
            <span>{host.name}</span>
            <span className="text-xs text-muted-foreground">
              {host.revokedAt ? 'revoked' : host.reachability}
              {host.lastHeartbeatAt ? ` · seen ${new Date(host.lastHeartbeatAt).toLocaleString()}` : ' · never connected'}
            </span>
          </li>
        ))}
        {mappings.map((m) => (
          <li key={m.id} className="flex items-center justify-between rounded border border-border bg-background px-2.5 py-1.5">
            <span className="font-mono text-xs">{m.repositoryKey}</span>
            <span className="text-xs text-muted-foreground">host {m.hostId.slice(0, 8)}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={createHost} className="mt-3 flex gap-2">
        <Button size="sm" variant="outline" type="submit" disabled={busy}>
          Enroll execution host
        </Button>
      </form>
      <form onSubmit={createMapping} className="mt-3 flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <select aria-label="Host" className="h-8 rounded border border-border bg-background px-2 text-xs" value={hostId} onChange={(e) => { setHostId(e.target.value); void loadCatalog(e.target.value); }}>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
          <Input className="h-8 w-56 text-xs" placeholder="repository key (e.g. org/repo)" value={repositoryKey} onChange={(e) => setRepositoryKey(e.target.value)} required />
        </div>
        <div className="flex flex-wrap gap-2">
          <Input className="h-8 w-72 text-xs" placeholder="allowed profile IDs (comma-separated)" value={profileIds} onChange={(e) => setProfileIds(e.target.value)} required />
          <Input className="h-8 w-56 text-xs" placeholder="default profile ID" value={defaultProfileId} onChange={(e) => setDefaultProfileId(e.target.value)} />
        </div>
        {catalog ? (
          <p className="text-xs text-muted-foreground">
            Host catalog: {catalog.repositories.map((r) => r.key).join(', ') || 'no repositories yet'} · profiles:{' '}
            {catalog.profiles.map((p) => p.id).join(', ') || 'none'}
          </p>
        ) : null}
        <Button size="sm" type="submit" disabled={busy} className="self-start">
          Add mapping
        </Button>
      </form>
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

function InsightsPanel({ projectId }: { projectId: string }) {
  const [insights, setInsights] = useState<InsightsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      try {
        const result = await collabFetch<InsightsResponse>(`/projects/${projectId}/insights?from=${from}&to=${to}`);
        setInsights(result.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Insights unavailable.');
      }
    })();
  }, [projectId]);

  return (
    <section aria-label="Project insights" className="rounded-lg border border-border bg-card p-4 text-sm">
      <h2 className="text-sm font-medium">Insights (last 30 days)</h2>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      {!insights && !error ? <p className="mt-2 text-xs text-muted-foreground">Loading…</p> : null}
      {insights ? (
        <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <div>Tasks created: <span className="text-foreground">{insights.tasks.createdCount}</span></div>
          <div>Tasks accepted: <span className="text-foreground">{insights.tasks.acceptedCount}</span></div>
          <div>Runs: <span className="text-foreground">{insights.runs.totalCount}</span></div>
          <div>Failed runs: <span className="text-foreground">{insights.runs.failedCount}</span></div>
          <div className="col-span-2">
            Token usage:{' '}
            {insights.usage.available ? (
              <span className="text-foreground">
                in {insights.usage.tokensIn ?? '—'} / out {insights.usage.tokensOut ?? '—'}
                {insights.usage.costUsd !== null ? ` · $${insights.usage.costUsd}` : ' · cost not reported by provider'}
                {insights.usage.reason?<span className="block text-muted-foreground">{insights.usage.reason}</span>:null}
                {insights.usage.coverage?<span className="block text-muted-foreground">Coverage: input {insights.usage.coverage.tokensIn}/{insights.usage.coverage.samples}, output {insights.usage.coverage.tokensOut}/{insights.usage.coverage.samples}, cost {insights.usage.coverage.costUsd}/{insights.usage.coverage.samples} samples</span>:null}
              </span>
            ) : (
              <span>not available from this provider{insights.usage.reason ? ` (${insights.usage.reason})` : ''}</span>
            )}
          </div>
        </dl>
      ) : null}
    </section>
  );
}
