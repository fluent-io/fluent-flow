import { describe, it, expect } from 'vitest';
import {
  repoConfigSchema,
  orgConfigSchema,
  gitHubWebhookEventSchema,
} from '../src/schemas';

describe('repoConfigSchema', () => {
  it('accepts a minimal valid config', () => {
    const parsed = repoConfigSchema.parse({
      default_agent: 'getonit',
      claim_types: ['review'],
      review_model: 'claude-haiku',
      paused: false,
    });
    expect(parsed.default_agent).toBe('getonit');
  });

  it('rejects an unknown claim_type', () => {
    expect(() =>
      repoConfigSchema.parse({
        default_agent: 'x',
        claim_types: ['nope'],
        review_model: 'm',
        paused: false,
      })
    ).toThrow();
  });
});

describe('orgConfigSchema', () => {
  it('accepts an empty object', () => {
    expect(orgConfigSchema.parse({})).toEqual({});
  });

  it('accepts partial overrides', () => {
    const parsed = orgConfigSchema.parse({ default_agent: 'getonit', paused: true });
    expect(parsed.default_agent).toBe('getonit');
    expect(parsed.paused).toBe(true);
  });
});

describe('gitHubWebhookEventSchema', () => {
  it('accepts installation.created', () => {
    const parsed = gitHubWebhookEventSchema.parse({
      event: 'installation',
      action: 'created',
      installation: { id: 1, account: { login: 'acme', type: 'Organization' } },
    });
    expect(parsed.event).toBe('installation');
  });

  it('accepts installation_repositories.added', () => {
    const parsed = gitHubWebhookEventSchema.parse({
      event: 'installation_repositories',
      action: 'added',
      installation: { id: 1 },
      repositories_added: [{ id: 10, full_name: 'acme/repo' }],
    });
    expect(parsed.action).toBe('added');
  });

  it('accepts pull_request.opened', () => {
    const parsed = gitHubWebhookEventSchema.parse({
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
      gitHubWebhookEventSchema.parse({ event: 'mystery', action: 'x' })
    ).toThrow();
  });
});
