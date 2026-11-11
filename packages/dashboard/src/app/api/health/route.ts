import { NextResponse } from 'next/server';

// Required for every production dashboard deployment. Missing any of these
// is a hard misconfiguration (NextAuth cannot run, or the collab proxy
// silently 503s every authenticated request) — the deploy pipeline polls
// this endpoint and must fail the deploy rather than let it go live broken.
const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'NEXTAUTH_SECRET',
  'NEXTAUTH_URL',
  'FF_COLLAB_API_URL',
  'FF_COLLAB_AUTH_SECRET',
] as const;

export async function GET() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(JSON.stringify({ component: 'dashboard-health', msg: 'missing required env vars', missing }));
    return NextResponse.json(
      { status: 'error', missingEnvVars: missing },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  return NextResponse.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
