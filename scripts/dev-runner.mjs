import { parseArgs, parseEnv } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: npm run runner -- [--profile <id>] [--enable-integration paseo]';
const ANSWER_USAGE = 'Usage: npm run runner -- answer --local [--request <id>]';
const COMMANDS = ['status', 'list', 'stop'];
if (COMMANDS.includes(process.argv[2])) {
  if (process.argv.length > 3) { console.error(`Usage: npm run runner -- ${process.argv[2]}`); process.exit(1); }
  const { runSupervisorCommand, savedInstance } = await import('../packages/fluent-flow-runner/src/supervisor/cli.js');
  let instance = null;
  try { instance = savedInstance(join(root, '.local/runner/connector.json')); }
  catch { instance = null; }
  if (!instance) { console.error('The local runner is not set up on this host. Run npm run runner first.'); process.exit(1); }
  process.exitCode = await runSupervisorCommand({ command: process.argv[2], ...instance, options: {}, io: { input: process.stdin, output: process.stderr } });
} else if (process.argv[2] === 'answer') {
  let answer;
  try { answer = parseArgs({ args: process.argv.slice(3), options: { local: { type: 'boolean' }, request: { type: 'string' } } }).values; }
  catch { answer = null; }
  if (!answer?.local) { console.error(ANSWER_USAGE); process.exit(1); }
  const { runLocalAnswer } = await import('../packages/fluent-flow-runner/src/supervisor/cli.js');
  process.exitCode = await runLocalAnswer({ configFile: join(root, '.local/runner/connector.json'), requestId: answer.request, input: process.stdin, output: process.stderr });
} else {
  let args;
  try { args = parseArgs({ options: { help: { type: 'boolean' }, profile: { type: 'string' }, 'enable-integration': { type: 'string', multiple: true } } }).values; }
  catch { console.error(USAGE); process.exit(1); }
  const enableIntegrations = args['enable-integration'] ?? [];
  if (!enableIntegrations.every(name => name === 'paseo')) { console.error(USAGE); process.exit(1); }
  if (args.help) {
    console.log(`${USAGE}\n\nStart npm run dev in another terminal first. This command prepares the local connector, a disposable demo repository and Project A1 execution settings from the profiles in .local/runner/profiles.json. --profile chooses the project default. Paseo is used only with --enable-integration paseo. Private state stays in .local/runner. AI tasks run only after you click Start.`);
  } else {
    let runtime, prepared, db, setup, configErrors;
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
      configErrors = await import('../packages/fluent-flow-runner/src/connector/config.js');
      const { resolveLocalDaemon } = await import('../packages/fluent-flow-runner/src/connector/paseo-local.js');
      const { connectLocalPaseo, createConnectorRuntime } = await import('../packages/fluent-flow-runner/src/connector/runtime.js');
      const connectPaseo = async () => connectLocalPaseo(await resolveLocalDaemon({ home: process.env.PASEO_HOME }));
      prepared = await setup.prepareLocalRunner({ root, profileId: args.profile, enableIntegrations, connectPaseo });
      if (!stopping) {
        let fatal = false;
        runtime = await createConnectorRuntime({ config: prepared.config, paseo: prepared.paseo ?? undefined, log: record => console.error(JSON.stringify(record)), onFatal: () => { fatal = true; console.error('Local runner authorization or connection failed. Check its private configuration.'); } });
        if (!stopping) {
          process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
          serving = true;
          if (await setup.serveLocalRunner({ runtime, prepared })) process.exitCode = 1;
        }
        if (fatal) process.exitCode = 1;
      }
    } catch (error) {
      const known = (setup && error instanceof setup.LocalRunnerError) || (configErrors && error instanceof configErrors.ConnectorConfigError);
      if (!known) console.error(JSON.stringify({ msg: 'local runner startup failed', error: error instanceof Error ? error.message : String(error) }));
      console.error(known ? error.message : 'Local runner startup failed. Check that npm run dev is running and that a complete execution profile is configured.');
      process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
      if (!serving) {
        try { if (runtime) await runtime.close(); else await prepared?.paseo?.close(); }
        finally { await prepared?.release(); }
      }
      await db?.closePool();
    }
  }
}
