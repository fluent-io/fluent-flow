import { parseArgs, parseEnv } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let args;
try { args = parseArgs({ options: { help: { type: 'boolean' }, profile: { type: 'string' } } }).values; }
catch { console.error('Usage: npm run runner -- [--profile <paseo-profile-id>]'); process.exit(1); }
if (args.help) {
  console.log('Usage: npm run runner -- [--profile <paseo-profile-id>]\n\nStart npm run dev in another terminal first. This command prepares the real local Paseo connector, a disposable demo repository and Project A1 execution settings. Private state stays in .local/runner. AI tasks run only after you click Start.');
} else {
  let runtime, prepared, paseo, db, setup;
  let serving = false;
  let stopping = false;
  const shutdown = () => { stopping = true; runtime?.loop.stop(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  try {
    execFileSync(process.execPath, [join(root, 'scripts/dev-database.mjs')], { cwd: root, stdio: 'inherit' });
    execFileSync('npm', ['run', 'build', '-w', '@fluent-flow/db'], { cwd: root, stdio: 'inherit' });
    process.env.DATABASE_URL ??= parseEnv(readFileSync(join(root, 'packages/fluent-flow/.env.local'), 'utf8')).DATABASE_URL;
    setup = await import('./dev-runner-setup.mjs');
    db = await import('@fluent-flow/db');
    const { resolveLocalDaemon } = await import('../packages/fluent-flow-runner/src/connector/paseo-local.js');
    const { connectLocalPaseo, createConnectorRuntime } = await import('../packages/fluent-flow-runner/src/connector/runtime.js');
    const connection = await resolveLocalDaemon({ home: process.env.PASEO_HOME });
    paseo = await connectLocalPaseo(connection);
    prepared = await setup.prepareLocalRunner({ root, paseo, profileId: args.profile });
    if (!stopping) {
      let fatal = false;
      runtime = await createConnectorRuntime({ config: prepared.config, paseo, log: record => console.error(JSON.stringify(record)), onFatal: () => { fatal = true; console.error('Local runner authorization or connection failed. Check its private configuration.'); } });
      if (!stopping) {
        process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
        serving = true;
        await setup.serveLocalRunner({ runtime, prepared });
      }
      if (fatal) process.exitCode = 1;
    }
  } catch (error) {
    console.error(setup && error instanceof setup.LocalRunnerError ? error.message : 'Local runner startup failed. Check that npm run dev and the local Paseo daemon are running, and that an existing coding profile is available.');
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
    if (!serving) {
      try { if (runtime) await runtime.close(); else await paseo?.close(); }
      finally { await prepared?.release(); }
    }
    await db?.closePool();
  }
}
