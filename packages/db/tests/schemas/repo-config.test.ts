import { describe, it, expect } from 'vitest';
import { RepoConfigSchema, OrgConfigSchema, GitHubWebhookEventSchema } from '../../src/schemas/index';

describe('RepoConfigSchema (TS)', () => {
  it('parses a valid repo config', () => {
    const result = RepoConfigSchema.parse({
      default_agent: 'getonit',
      claim_types: ['review', 'verify', 'test_verify'],
      review_model: 'claude-opus-4-6',
      paused: false,
    });
    expect(result.default_agent).toBe('getonit');
    expect(result.claim_types).toEqual(['review', 'verify', 'test_verify']);
  });

  it('throws on unknown claim_types entry', () => {
    expect(() =>
      RepoConfigSchema.parse({ claim_types: ['review', 'not-valid'] })
    ).toThrow();
  });

  it('allows empty object', () => {
    expect(RepoConfigSchema.parse({})).toBeDefined();
  });
});

describe('OrgConfigSchema (TS)', () => {
  it('parses empty object', () => {
    expect(OrgConfigSchema.parse({})).toBeDefined();
  });

  it('accepts verify and historical test_verify default claim types', () => {
    const result = OrgConfigSchema.parse({ default_claim_types: ['review_fix', 'verify', 'test_verify'] });
    expect(result.default_claim_types).toEqual(['review_fix', 'verify', 'test_verify']);
  });
});

describe('GitHubWebhookEventSchema (TS)', () => {
  it('accepts installation.created', () => {
    const result = GitHubWebhookEventSchema.parse({
      event: 'installation',
      action: 'created',
      installation: { id: 1, account: { login: 'acme', type: 'Organization' } },
    });
    expect(result.event).toBe('installation');
  });

  it('accepts installation_repositories.added', () => {
    const result = GitHubWebhookEventSchema.parse({
      event: 'installation_repositories',
      action: 'added',
      installation: { id: 1 },
    });
    expect(result.event).toBe('installation_repositories');
  });

  it('accepts pull_request.opened', () => {
    const result = GitHubWebhookEventSchema.parse({
      event: 'pull_request',
      action: 'opened',
      installation: { id: 1 },
    });
    expect(result.event).toBe('pull_request');
  });

  it('rejects unknown event', () => {
    expect(() =>
      GitHubWebhookEventSchema.parse({ event: 'unknown_xyz', action: 'created' })
    ).toThrow();
  });
});
