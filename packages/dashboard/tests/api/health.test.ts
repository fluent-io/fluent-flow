import { describe, it, expect, afterEach } from 'vitest';

const REQUIRED_ENV_VARS = ['DATABASE_URL', 'NEXTAUTH_SECRET', 'NEXTAUTH_URL', 'FF_COLLAB_API_URL', 'FF_COLLAB_AUTH_SECRET'] as const;

const { GET } = await import('../../src/app/api/health/route');

describe('GET /api/health', () => {
  const originalValues: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of REQUIRED_ENV_VARS) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  });

  function setAll() {
    for (const key of REQUIRED_ENV_VARS) {
      originalValues[key] = process.env[key];
      process.env[key] = 'test-value';
    }
  }

  it('returns 200 when all required env vars are present', async () => {
    setAll();
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('ok');
  });

  it.each(REQUIRED_ENV_VARS)('returns 503 when %s is missing', async (missingKey) => {
    setAll();
    originalValues[missingKey] = process.env[missingKey];
    delete process.env[missingKey];

    const response = await GET();
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.missingEnvVars).toContain(missingKey);
  });
});
