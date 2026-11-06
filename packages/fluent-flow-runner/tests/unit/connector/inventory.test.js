import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventoryFlowlyData } from '../../../src/connector/inventory.js';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ff-inv-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('Flowly inventory over REAL temp roots', () => {
  it('reports not-found with the exact searched roots when nothing exists', () => {
    const inv = inventoryFlowlyData({
      paseoHome: join(tmp, 'empty-home'),
      repositories: {},
      io: { env: {} },
    });
    expect(inv.summary.realDataFound).toBe(false);
    const checkedRoots = inv.searched.filter((s) => s.checked === 'board.json').map((s) => s.root);
    expect(checkedRoots).toContain(join(tmp, 'empty-home', 'plugin-data', 'flowly'));
    expect(checkedRoots).toContain(join(tmp, 'empty-home', 'plugin-data', 'paseo-ultra-kanban'));
    expect(inv.findings.filter((f) => f.status === 'not_found')).toHaveLength(2);
  });

  it('finds a REAL planted board.json with version, schema and task count', () => {
    const dataDir = join(tmp, 'home', 'plugin-data', 'flowly');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'board.json'), JSON.stringify({ version: 4, schema: 'flowly-board', tasks: [{ id: 't1' }, { id: 't2' }] }));
    const inv = inventoryFlowlyData({ paseoHome: join(tmp, 'home'), repositories: {}, io: { env: {} } });
    expect(inv.summary.realDataFound).toBe(true);
    const found = inv.findings.find((f) => f.status === 'found');
    expect(found.board.version).toBe(4);
    expect(found.board.schema).toBe('flowly-board');
    expect(found.board.taskCount).toBe(2);
    expect(found.board.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('counts .flowly/project.json markers under the projects directory, bounded', () => {
    const dataDir = join(tmp, 'home', 'plugin-data', 'flowly');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'board.json'), '{"version":4,"tasks":[]}');
    for (const name of ['p1', 'p2']) {
      mkdirSync(join(dataDir, 'projects', name, '.flowly'), { recursive: true });
      writeFileSync(join(dataDir, 'projects', name, '.flowly', 'project.json'), JSON.stringify({ projectId: name }));
    }
    const inv = inventoryFlowlyData({ paseoHome: join(tmp, 'home'), repositories: {}, io: { env: {} } });
    const found = inv.findings.find((f) => f.status === 'found');
    expect(found.projectMarkers).toHaveLength(2);
  });

  it('honors FLOWLY_DATA_DIR and ULTRA_KANBAN_DATA_DIR as named roots', () => {
    const dir = join(tmp, 'custom');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'board.json'), '{"version":4,"tasks":[]}');
    const inv = inventoryFlowlyData({
      paseoHome: join(tmp, 'no-home'),
      repositories: {},
      io: { env: { FLOWLY_DATA_DIR: dir } },
    });
    expect(inv.summary.realDataFound).toBe(true);
    expect(inv.findings.some((f) => f.origin === 'FLOWLY_DATA_DIR' && f.status === 'found')).toBe(true);
  });

  it('checks .flowly/project.json in configured repositories', () => {
    const repo = join(tmp, 'repo');
    mkdirSync(join(repo, '.flowly'), { recursive: true });
    writeFileSync(join(repo, '.flowly', 'project.json'), '{"projectId":"linked"}');
    const inv = inventoryFlowlyData({ paseoHome: join(tmp, 'no-home'), repositories: { 'my-repo': repo }, io: { env: {} } });
    expect(inv.summary.realDataFound).toBe(true);
    expect(inv.repositoryMarkers[0]).toMatchObject({ repositoryKey: 'my-repo', readable: true });
  });

  it('never claims a migration: manifest is read-only counts and hashes', () => {
    const inv = inventoryFlowlyData({ paseoHome: join(tmp, 'no-home'), repositories: {}, io: { env: {} } });
    expect(JSON.stringify(inv)).not.toMatch(/migrat(ed|ion complete|ion success)/i);
    expect(inv.summary.realDataFound).toBe(false);
  });
});
