'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, Kanban, Pencil, RefreshCw, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, collabFetch } from '@/lib/collab/api';
import { LatestRequest } from '@/lib/collab/live';
import { capabilitiesFor, useMe, workspaceCapabilitiesFor } from '@/lib/collab/use-me';
import { useCurrentProject, useSyncCurrentProject } from '@/lib/collab/current-project';
import type { MeResponse } from '@/lib/collab/types';
import { ProjectCreate } from './settings-view';

export interface ProjectOverview {
  linkedRepoFullName: string | null;
  id: string;
  workspaceId: string;
  workspaceName: string;
  name: string;
  version: number;
  boardVersion: number;
  description: string;
  runInstructions: string;
  testInstructions: string;
}

const TEXT_LIMIT = 20000;
const NAME_LIMIT = 200;
const FIELD_CLASS =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

function accessLabel(caps: string[]): string {
  if (caps.includes('project.admin')) return 'Can edit';
  if (caps.includes('task.write')) return 'Can add tasks';
  return 'Read only';
}

export function ProjectsPage() {
  const { me, error, reload } = useMe();
  if (error && !me) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <AlertTriangle className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Could not load your projects.</p>
        <Button variant="outline" onClick={() => void reload()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!me) return <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>;
  return <ProjectsList me={me} onCreated={reload} />;
}

export function ProjectsList({ me, onCreated }: { me: MeResponse; onCreated: () => Promise<void> }) {
  const total = me.workspaces.reduce((sum, w) => sum + w.projects.length, 0);
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Projects</h1>
        <p className="mt-1 text-sm text-muted-foreground">What each project is, and how to run and test it.</p>
      </div>
      {total === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          No projects yet. A workspace admin can create one or add you to an existing project.
        </p>
      ) : null}
      {me.workspaces.map((w) => {
        const canCreate = workspaceCapabilitiesFor(me, w.id).includes('project.admin');
        if (w.projects.length === 0 && !canCreate) return null;
        return (
          <section key={w.id} aria-label={w.name} className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-muted-foreground">{w.name}</h2>
            {w.projects.length > 0 ? (
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {w.projects.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                    <Link href={`/projects/${p.id}`} className="min-w-0 break-words text-sm font-medium underline-offset-4 hover:underline">
                      {p.name}
                      {p.linkedRepoFullName ? <span className="ml-2 text-xs font-normal text-muted-foreground">Linked to {p.linkedRepoFullName}</span> : null}
                    </Link>
                    <span className="text-xs text-muted-foreground">{accessLabel(capabilitiesFor(me, p.id))}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No projects in this client yet.</p>
            )}
            <ProjectCreate projectId={null} workspaceId={w.id} canCreate={canCreate} onCreated={onCreated} />
          </section>
        );
      })}
    </div>
  );
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not_found' }
  | { kind: 'error' }
  | { kind: 'loaded'; overview: ProjectOverview };

export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const { me, reload: reloadCatalog } = useMe();
  const current = useCurrentProject();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const requests = useRef(new LatestRequest());
  useSyncCurrentProject(projectId);
  const revoked = (current.ready && !current.projects.some((p) => p.id === projectId)) || current.accessLost;
  const gone = useRef(false);
  useEffect(() => {
    if (!revoked) return;
    gone.current = true;
    requests.current.dispose();
    setState({ kind: 'not_found' });
  }, [revoked]);

  const load = useCallback(async () => {
    const signal = requests.current.begin();
    try {
      const result = await collabFetch<ProjectOverview>(`/projects/${projectId}`, { signal });
      if (!requests.current.current(signal) || gone.current) return;
      setState({ kind: 'loaded', overview: result.data });
    } catch (err) {
      if (!requests.current.current(signal)) return;
      const missing = err instanceof ApiError && [400, 401, 403, 404].includes(err.status);
      setState({ kind: missing ? 'not_found' : 'error' });
    }
  }, [projectId]);

  useEffect(() => {
    setState({ kind: 'loading' });
    void load();
    return () => requests.current.dispose();
  }, [load]);

  const back = (
    <Button variant="ghost" size="sm" asChild>
      <Link href="/projects">
        <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Projects
      </Link>
    </Button>
  );

  if (state.kind === 'loading') return <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>;
  if (state.kind === 'not_found' || revoked) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <p className="text-sm text-muted-foreground">Project not found, or you no longer have access to it.</p>
        {back}
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <AlertTriangle className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Could not load this project.</p>
        <Button variant="outline" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  const caps = capabilitiesFor(me, projectId);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>{back}</div>
      <ProjectOverviewPanel
        key={state.overview.version}
        overview={state.overview}
        canEdit={caps.includes('project.admin')}
        canOpenSettings={caps.includes('project.admin') || caps.includes('membership.admin')}
        onSaved={(overview) => {
          if (gone.current) return;
          setState({ kind: 'loaded', overview });
          void reloadCatalog();
        }}
        onReload={load}
        onGone={() => setState({ kind: 'not_found' })}
      />
    </div>
  );
}

const SECTIONS = [
  { field: 'description', label: 'Description', heading: 'Overview', empty: 'No description yet.' },
  { field: 'runInstructions', label: 'How to run', heading: 'How to run', empty: 'No run instructions yet.' },
  { field: 'testInstructions', label: 'How to test', heading: 'How to test', empty: 'No test instructions yet.' },
] as const;

type Draft = Pick<ProjectOverview, 'name' | 'description' | 'runInstructions' | 'testInstructions'>;

export function ProjectOverviewPanel({
  overview,
  canEdit,
  canOpenSettings,
  onSaved,
  onReload,
  onGone,
}: {
  overview: ProjectOverview;
  canEdit: boolean;
  canOpenSettings: boolean;
  onSaved: (overview: ProjectOverview) => void;
  onReload?: () => Promise<void>;
  onGone?: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; conflict: boolean } | null>(null);

  function startEditing() {
    setError(null);
    setDraft({ name: overview.name, description: overview.description, runInstructions: overview.runInstructions, testInstructions: overview.testInstructions });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const result = await collabFetch<ProjectOverview>(`/projects/${overview.id}/overview`, {
        method: 'PATCH',
        body: { expectedVersion: overview.version, ...draft },
      });
      setDraft(null);
      onSaved(result.data);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 409) setError({ message: 'This project changed since you started editing. Reload to see the latest version; your draft stays here until you do.', conflict: true });
      else if (status === 403) setError({ message: 'You no longer have permission to edit this project.', conflict: false });
      else if (status === 404) {
        if (onGone) onGone();
        else setError({ message: 'This project is no longer available.', conflict: false });
      }
      else if (status === 400) setError({ message: 'Check the name and text lengths, then try again.', conflict: false });
      else setError({ message: 'Could not save the overview. Try again.', conflict: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words text-xl font-semibold">{overview.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{overview.workspaceName}</p>
          {overview.linkedRepoFullName ? <p className="mt-1 break-words text-sm text-muted-foreground">Linked to {overview.linkedRepoFullName}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/board?projectId=${overview.id}`}>
              <Kanban className="mr-1 h-3.5 w-3.5" /> Open board
            </Link>
          </Button>
          {canOpenSettings ? (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/settings?projectId=${overview.id}`}>
                <Settings className="mr-1 h-3.5 w-3.5" /> Settings
              </Link>
            </Button>
          ) : null}
          {canEdit && !draft ? (
            <Button size="sm" onClick={startEditing}>
              <Pencil className="mr-1 h-3.5 w-3.5" /> Edit overview
            </Button>
          ) : null}
        </div>
      </header>

      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">{error.message}</span>
          {error.conflict && onReload ? (
            <Button size="sm" variant="outline" onClick={() => { setDraft(null); setError(null); void onReload(); }}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> Reload project
            </Button>
          ) : null}
        </div>
      ) : null}

      {draft ? (
        <form onSubmit={save} className="flex flex-col gap-4" aria-label="Edit project overview">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="project-name" className="text-sm font-medium">Name</label>
            <Input id="project-name" required maxLength={NAME_LIMIT} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          {SECTIONS.map((s) => (
            <div key={s.field} className="flex flex-col gap-1.5">
              <label htmlFor={`project-${s.field}`} className="text-sm font-medium">{s.label}</label>
              <textarea
                id={`project-${s.field}`}
                className={`${FIELD_CLASS} ${s.field === 'description' ? 'min-h-[120px]' : 'min-h-[96px]'}`}
                maxLength={TEXT_LIMIT}
                value={draft[s.field]}
                onChange={(e) => setDraft({ ...draft, [s.field]: e.target.value })}
              />
            </div>
          ))}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => { setDraft(null); setError(null); }}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save overview'}
            </Button>
          </div>
        </form>
      ) : (
        SECTIONS.map((s) => (
          <section key={s.field} aria-label={s.heading} className="flex flex-col gap-1.5">
            <h2 className="text-sm font-semibold">{s.heading}</h2>
            {overview[s.field] ? (
              <p className="max-w-[72ch] whitespace-pre-wrap break-words text-sm leading-relaxed">
                {overview[s.field]}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{s.empty}</p>
            )}
          </section>
        ))
      )}
    </article>
  );
}
