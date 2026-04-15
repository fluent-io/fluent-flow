import { describe, it, expect } from 'vitest';
import { RepoConfigSchema, OrgConfigSchema, GitHubWebhookEventSchema } from '../../src/config/provider-schema.js';

describe('RepoConfigSchema', () => {
  it('parses a valid repo config', () => {
    const result = RepoConfigSchema.parse({
      default_agent: 'getonit',
      claim_types: ['review'],
      review_model: 'claude-opus-4-6',
      paused: false,
    });
    expect(result.default_agent).toBe('getonit');
    expect(result.claim_types).toEqual(['review']);
    expect(result.review_model).toBe('claude-opus-4-6');
    expect(result.paused).toBe(false);
  });

  it('throws on unknown claim_types entry', () => {
    expect(() =>
      RepoConfigSchema.parse({
        claim_types: ['review', 'not-a-valid-type'],
      })
    ).toThrow();
  });

  it('allows all optional fields to be absent', () => {
    const result = RepoConfigSchema.parse({});
    expect(result).toBeDefined();
  });
});

describe('OrgConfigSchema', () => {
  it('parses an empty object (all fields optional)', () => {
    const result = OrgConfigSchema.parse({});
    expect(result).toBeDefined();
  });

  it('parses with optional fields set', () => {
    const result = OrgConfigSchema.parse({ default_review_model: 'claude-haiku-4-5-20251001' });
    expect(result.default_review_model).toBe('claude-haiku-4-5-20251001');
  });
});

describe('GitHubWebhookEventSchema', () => {
  it('accepts installation.created payload', () => {
    const result = GitHubWebhookEventSchema.parse({
      event: 'installation',
      action: 'created',
      installation: { id: 1, account: { login: 'acme', type: 'Organization' } },
      repositories: [],
    });
    expect(result.event).toBe('installation');
    expect(result.action).toBe('created');
  });

  it('accepts installation_repositories.added payload', () => {
    const result = GitHubWebhookEventSchema.parse({
      event: 'installation_repositories',
      action: 'added',
      installation: { id: 1, account: { login: 'acme', type: 'Organization' } },
      repositories_added: [{ id: 42, full_name: 'acme/repo', private: false }],
      repositories_removed: [],
    });
    expect(result.event).toBe('installation_repositories');
    expect(result.action).toBe('added');
  });

  it('accepts pull_request.opened payload', () => {
    const result = GitHubWebhookEventSchema.parse({
      event: 'pull_request',
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 5, head: { sha: 'abc123' }, body: '' },
      repository: { id: 42, full_name: 'acme/repo' },
    });
    expect(result.event).toBe('pull_request');
  });

  it('rejects an unknown event name', () => {
    expect(() =>
      GitHubWebhookEventSchema.parse({
        event: 'unknown_event_xyz',
        action: 'created',
      })
    ).toThrow();
  });
});
