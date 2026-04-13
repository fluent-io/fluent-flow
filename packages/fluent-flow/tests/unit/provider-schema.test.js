import { describe, it, expect } from 'vitest';
import {
  RepoConfigSchema,
  OrgConfigSchema,
  GitHubWebhookEventSchema,
} from '../../src/config/provider-schema.js';

describe('RepoConfigSchema', () => {
  it('accepts a minimal valid config', () => {
    const parsed = RepoConfigSchema.parse({
      default_agent: 'getonit',
      claim_types: ['review'],
      review_model: 'claude-haiku',
      paused: false,
    });
    expect(parsed.default_agent).toBe('getonit');
    expect(parsed.claim_types).toEqual(['review']);
    expect(parsed.paused).toBe(false);
  });

  it('rejects an unknown claim_type', () => {
    expect(() =>
      RepoConfigSchema.parse({
        default_agent: 'x',
        claim_types: ['nope'],
        review_model: 'm',
        paused: false,
      })
    ).toThrow();
  });

  it('rejects missing default_agent', () => {
    expect(() =>
      RepoConfigSchema.parse({
        claim_types: ['review'],
        review_model: 'm',
        paused: false,
      })
    ).toThrow();
  });
});

describe('OrgConfigSchema', () => {
  it('accepts an empty object', () => {
    const parsed = OrgConfigSchema.parse({});
    expect(parsed).toEqual({});
  });

  it('accepts partial overrides', () => {
    const parsed = OrgConfigSchema.parse({ default_agent: 'getonit', paused: true });
    expect(parsed.default_agent).toBe('getonit');
    expect(parsed.paused).toBe(true);
  });

  it('rejects an unknown claim_type in partial config', () => {
    expect(() => OrgConfigSchema.parse({ claim_types: ['bogus'] })).toThrow();
  });
});

describe('GitHubWebhookEventSchema', () => {
  it('accepts installation.created', () => {
    const parsed = GitHubWebhookEventSchema.parse({
      event: 'installation',
      action: 'created',
      installation: { id: 1, account: { login: 'acme', type: 'Organization' } },
    });
    expect(parsed.event).toBe('installation');
  });

  it('accepts installation_repositories.added', () => {
    const parsed = GitHubWebhookEventSchema.parse({
      event: 'installation_repositories',
      action: 'added',
      installation: { id: 1 },
      repositories_added: [{ id: 10, full_name: 'acme/repo' }],
    });
    expect(parsed.action).toBe('added');
  });

  it('accepts pull_request.opened', () => {
    const parsed = GitHubWebhookEventSchema.parse({
      event: 'pull_request',
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 42 },
      repository: { id: 10, full_name: 'acme/repo' },
    });
    expect(parsed.event).toBe('pull_request');
  });

  it('rejects an unknown event name', () => {
    expect(() =>
      GitHubWebhookEventSchema.parse({ event: 'mystery', action: 'x' })
    ).toThrow();
  });
});
