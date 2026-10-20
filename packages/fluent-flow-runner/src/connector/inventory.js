import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Bounded READ-ONLY inventory of Flowly data at NAMED roots only (C4).
 *
 * Roots (exact, from the upstream source — service.ts dataDirectory()):
 * - $FLOWLY_DATA_DIR / $ULTRA_KANBAN_DATA_DIR when set
 * - <paseoHome>/plugin-data/flowly             (current plugin id)
 * - <paseoHome>/plugin-data/paseo-ultra-kanban  (legacy plugin id)
 * Plus `.flowly/project.json` markers inside configured repository checkouts.
 *
 * Files read: `board.json` per root and bounded `.flowly/project.json`
 * markers — manifest carries hashes, versions and counts ONLY. Nothing is
 * written, moved or deleted. Absence is reported per root with the exact
 * searched path; absence at custom/remote hosts stays explicitly unknown.
 */

const MAX_PROJECT_MARKERS = 50;

function inspectJsonFile(path) {
  try {
    const data = readFileSync(path);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const sizeBytes = data.length;
    try {
      const parsed = JSON.parse(data.toString('utf8'));
      return {
        file: path, present: true, readable: true, sha256, sizeBytes,
        version: parsed.version ?? parsed.schemaVersion ?? null,
        schema: parsed.schema ?? null,
        taskCount: Array.isArray(parsed.tasks) ? parsed.tasks.length : null,
      };
    } catch {
      return { file: path, present: true, readable: false, sha256, sizeBytes, note: 'unparseable_json' };
    }
  } catch {
    return { file: path, present: false };
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.paseoHome] - default ~/.paseo
 * @param {Record<string, string>} [opts.repositories] - configured repo keys -> paths
 * @param {{env?: object}} [opts.io]
 */
export function inventoryFlowlyData({ paseoHome, repositories = {}, io = {} } = {}) {
  const env = io.env ?? process.env;
  const home = paseoHome ?? join(homedir(), '.paseo');

  const roots = [];
  if (env.FLOWLY_DATA_DIR) roots.push({ root: resolve(env.FLOWLY_DATA_DIR), origin: 'FLOWLY_DATA_DIR' });
  if (env.ULTRA_KANBAN_DATA_DIR) roots.push({ root: resolve(env.ULTRA_KANBAN_DATA_DIR), origin: 'ULTRA_KANBAN_DATA_DIR' });
  roots.push({ root: join(home, 'plugin-data', 'flowly'), origin: 'default-current-plugin-id' });
  roots.push({ root: join(home, 'plugin-data', 'paseo-ultra-kanban'), origin: 'default-legacy-plugin-id' });

  const searched = [];
  const findings = [];
  for (const { root, origin } of roots) {
    const boardPath = join(root, 'board.json');
    searched.push({ root, origin, checked: 'board.json' });
    if (!existsSync(boardPath)) {
      findings.push({ root, origin, status: 'not_found', note: 'no board.json at this root' });
      continue;
    }
    const board = inspectJsonFile(boardPath);
    const projectsDir = join(root, 'projects');
    const projectMarkers = [];
    if (existsSync(projectsDir)) {
      let entries = [];
      try {
        entries = readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).slice(0, MAX_PROJECT_MARKERS);
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        const marker = join(projectsDir, entry.name, '.flowly', 'project.json');
        searched.push({ root, origin, checked: join('projects', entry.name, '.flowly', 'project.json') });
        if (existsSync(marker)) projectMarkers.push(inspectJsonFile(marker));
      }
    }
    findings.push({ root, origin, status: 'found', board, projectMarkers, projectMarkerLimit: MAX_PROJECT_MARKERS });
  }

  const repoMarkers = [];
  for (const [key, repoPath] of Object.entries(repositories)) {
    const marker = join(repoPath, '.flowly', 'project.json');
    searched.push({ root: repoPath, origin: `repo:${key}`, checked: '.flowly/project.json' });
    if (existsSync(marker)) repoMarkers.push({ repositoryKey: key, ...inspectJsonFile(marker) });
  }

  const anyFound = findings.some((f) => f.status === 'found') || repoMarkers.length > 0;
  return {
    searchedAt: new Date().toISOString(),
    searched,
    findings,
    repositoryMarkers: repoMarkers,
    summary: anyFound
      ? {
          realDataFound: true,
          rootsWithBoard: findings.filter((f) => f.status === 'found').length,
          repositoryMarkers: repoMarkers.length,
          note: 'Real Flowly data found. Read-only manifest; migration is a separate authorized step with the backend owner.',
        }
      : {
          realDataFound: false,
          note: 'No Flowly board data at the named roots. Absence at other hosts or custom data dirs is unknown.',
        },
  };
}
