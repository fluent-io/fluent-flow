'use client';

import { usePathname, useRouter } from 'next/navigation';
import { routeForProjectSelection, useCurrentProject } from '@/lib/collab/current-project';

export function ProjectSelector() {
  const { ready, projectId, workspaces, catalogError, selectProject } = useCurrentProject();
  const router = useRouter();
  const pathname = usePathname();

  function onChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value || null;
    selectProject(next);
    const target = routeForProjectSelection(pathname, next, window.location.search);
    if (target) router.push(target);
  }

  return (
    <select
      aria-label="Current project"
      title="Current project"
      className="h-8 w-36 min-w-0 truncate rounded-md border border-border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60 sm:w-56"
      value={projectId ?? ''}
      disabled={!ready}
      onChange={onChange}
    >
      {/* Until the catalog validates the saved choice, do not claim All projects. */}
      <option value="">{ready ? 'All projects' : catalogError ? 'Projects unavailable' : 'Loading projects…'}</option>
      {workspaces.map((w) =>
        w.projects.length > 0 ? (
          <optgroup key={w.id} label={w.name}>
            {w.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        ) : null,
      )}
    </select>
  );
}
