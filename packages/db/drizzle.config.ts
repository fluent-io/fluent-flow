import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema/index.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://fluentflow:password@localhost:5432/fluentflow',
  },
  // Track migrations in a Drizzle-native table; the one-shot baseline stamper
  // (see src/migrate.ts) prevents re-running the 17 legacy .sql migrations
  // already applied to prod.
  migrations: {
    table: '__drizzle_migrations',
    schema: 'drizzle',
  },
  verbose: true,
  strict: true,
} satisfies Config;
