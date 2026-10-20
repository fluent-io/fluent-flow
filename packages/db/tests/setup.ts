// Runs before every db test module: @fluent-flow/db resolves DATABASE_URL and
// creates its pool eagerly at import time, so the dedicated collab test URL
// must be in place before any src module loads.
if (!process.env.DATABASE_URL) {
  const dedicated = process.env.COLLAB_DB_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (dedicated) {
    process.env.DATABASE_URL = dedicated;
  }
}
