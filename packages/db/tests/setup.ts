if (!process.env.DATABASE_URL) {
  const dedicated = process.env.COLLAB_DB_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (dedicated) {
    process.env.DATABASE_URL = dedicated;
  }
}
