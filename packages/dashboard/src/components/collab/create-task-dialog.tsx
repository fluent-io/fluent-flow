'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { collabFetch, ApiError } from '@/lib/collab/api';
import { capabilitiesFor } from '@/lib/collab/use-me';
import type { MeResponse, Priority, Project, Task } from '@/lib/collab/types';

const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];

/**
 * Backlog capture needs no repository, host, run or session prerequisite —
 * a task is created directly on the project.
 */
export function CreateTaskDialog({
  projects,
  me,
  defaultStatus,
  onClose,
  onCreated,
}: {
  projects: Project[];
  me: MeResponse | null;
  defaultStatus: Task['status'];
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const writable = projects.filter((p) => capabilitiesFor(me, p.id).includes('task.write'));
  const [projectId, setProjectId] = useState(writable[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!projectId || title.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await collabFetch<Task>(`/projects/${projectId}/tasks`, {
        method: 'POST',
        body: {
          title: title.trim(),
          description: description.trim(),
          priority,
        },
      });
      let task = result.data;
      if (defaultStatus !== 'backlog') {
        // Capture stays in backlog unless the operator explicitly readied it;
        // moving lanes is a separate, human decision.
        const moved = await collabFetch<{ task: Task; boardVersion: number }>(`/tasks/${task.id}/moves`, {
          method: 'POST',
          body: {
            expectedVersion: task.version,
            expectedBoardVersion: projects.find((p) => p.id === projectId)?.boardVersion ?? 0,
            status: defaultStatus,
            beforeTaskId: null,
            afterTaskId: null,
          },
        });
        task = moved.data.task;
      }
      onCreated(task);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('This item changed. Refresh before saving.');
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Could not create the task.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Create task"
        className="w-full max-w-md rounded-lg border border-border bg-background p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">New task</h2>
        <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
          <select
            aria-label="Project"
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            required
          >
            {writable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Input
            placeholder="Title"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
          <textarea
            className="min-h-[80px] rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder="Description (optional) — visible to client collaborators per project visibility rules"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <select
            aria-label="Priority"
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          {error ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create task'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
