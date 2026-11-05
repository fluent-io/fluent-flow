
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MARKERS = Object.freeze({
  claudeMd: 'FF-PROBE-CLAUDE-MD-MARKER-7f3a',
  agentsMd: 'FF-PROBE-AGENTS-MD-MARKER-2c9e',
  plantedModel: 'planted-model',
  plantedMcp: 'ff_planted_mcp_json',
  plantedCodexMcp: 'ff_planted_codex_toml',
  plantedRootMcp: 'ff_planted_root_toml',
});

/**
 * @param {'claude-code'|'codex'} backend
 */
export async function createProbeContext(backend) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ff-native-${backend}-`)));
  const home = join(root, 'home');
  const contextDir = join(root, 'context');
  const repoDir = join(root, 'repo');
  for (const dir of [home, contextDir]) {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  mkdirSync(repoDir);
  const hookMarker = join(root, 'planted-hook-ran');

  /** @type {{ path: string, method: string }[]} */
  const plantedHits = [];
  const planted = http.createServer((req, res) => {
    plantedHits.push({ path: req.url ?? '', method: req.method ?? '' });
    req.resume();
    res.writeHead(404).end();
  });
  await new Promise((r) => planted.listen(0, '127.0.0.1', () => r(undefined)));
  const plantedPort = /** @type {import('node:net').AddressInfo} */ (planted.address()).port;
  const plantedUrl = (name) => `http://127.0.0.1:${plantedPort}/${name}`;

  writeFileSync(join(repoDir, 'CLAUDE.md'), `# Probe repo\n\n${MARKERS.claudeMd}\n`);
  writeFileSync(join(repoDir, 'AGENTS.md'), `# Probe repo\n\n${MARKERS.agentsMd}\n`);
  writeFileSync(join(repoDir, 'README.md'), '# readme\n');
  mkdirSync(join(repoDir, '.claude'));
  writeFileSync(
    join(repoDir, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: `touch ${hookMarker}` }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch ${hookMarker}` }] }],
      },
    }),
  );
  writeFileSync(
    join(repoDir, '.mcp.json'),
    JSON.stringify({ mcpServers: { [MARKERS.plantedMcp]: { type: 'http', url: plantedUrl(MARKERS.plantedMcp) } } }),
  );
  mkdirSync(join(repoDir, '.codex'));
  writeFileSync(
    join(repoDir, '.codex', 'config.toml'),
    `model = "${MARKERS.plantedModel}"\n[mcp_servers.${MARKERS.plantedCodexMcp}]\nurl = "${plantedUrl(MARKERS.plantedCodexMcp)}"\n`,
  );
  writeFileSync(
    join(repoDir, 'config.toml'),
    `model = "${MARKERS.plantedModel}"\n[mcp_servers.${MARKERS.plantedRootMcp}]\nurl = "${plantedUrl(MARKERS.plantedRootMcp)}"\n`,
  );
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=FF Probe', '-c', 'user.email=probe@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
      cwd: repoDir,
      env: { PATH: process.env.PATH ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'ignore',
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'probe fixture');
  const worktreeDir = join(root, 'worktree');
  git('worktree', 'add', '-q', '-b', 'ff-probe-worktree', worktreeDir);

  /** @type {Record<string, string>} */
  const parentEnv = { HOME: home };
  for (const key of ['PATH', 'LANG', 'TZ']) if (process.env[key]) parentEnv[key] = process.env[key];

  return {
    root,
    home,
    contextDir,
    repoDir,
    worktreeDir: realpathSync(worktreeDir),
    hookMarker,
    plantedHits,
    parentEnv,
    async cleanup() {
      planted.closeAllConnections();
      await new Promise((r) => planted.close(() => r(undefined)));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function probeSpawnExtras({ home, proxyUrl }) {
  return {
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}
