import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

// Mock node:os
const mockHomedir = vi.fn(() => '/home/testuser');
vi.mock('node:os', () => ({
  homedir: () => mockHomedir(),
}));

// Mock node:fs — must use vi.mock for ESM namespace
const mockMkdirSync = vi.fn(() => '/home/testuser/.fluent-flow');
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();

vi.mock('node:fs', () => ({
  mkdirSync: (...args) => mockMkdirSync(...args),
  readFileSync: (...args) => mockReadFileSync(...args),
  writeFileSync: (...args) => mockWriteFileSync(...args),
}));

// Import after mocks are set up
import {
  loadCredentials,
  saveCredentials,
  getAgentCredentials,
  setAgentCredentials,
} from '../../src/credentials.js';

describe('credentials', () => {
  // Use join to compute expected paths so they match the platform separator
  const homeDir = '/home/testuser';
  const credDir = join(homeDir, '.fluent-flow');
  const credPath = join(credDir, 'credentials.json');

  beforeEach(() => {
    vi.clearAllMocks();
    mockHomedir.mockReturnValue(homeDir);
    mockWriteFileSync.mockImplementation(() => {});
  });

  describe('loadCredentials()', () => {
    it('returns parsed credentials when file exists', () => {
      const data = {
        agents: {
          'my-agent': { token: 'ff_abc', server: 'https://flow.example.com' },
        },
        default_agent: 'my-agent',
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(data));

      const result = loadCredentials();
      expect(result).toEqual(data);
      expect(mockReadFileSync).toHaveBeenCalledWith(credPath, 'utf-8');
    });

    it('returns empty default when file does not exist', () => {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      mockReadFileSync.mockImplementation(() => { throw error; });

      const result = loadCredentials();
      expect(result).toEqual({ agents: {}, default_agent: null });
    });

    it('returns empty default when file contains invalid JSON', () => {
      mockReadFileSync.mockReturnValue('not valid json');

      const result = loadCredentials();
      expect(result).toEqual({ agents: {}, default_agent: null });
    });
  });

  describe('saveCredentials()', () => {
    it('writes credentials JSON to file and creates directory', () => {
      const data = {
        agents: { 'my-agent': { token: 'ff_abc', server: 'https://flow.example.com' } },
        default_agent: 'my-agent',
      };

      saveCredentials(data);

      expect(mockMkdirSync).toHaveBeenCalledWith(credDir, { recursive: true });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        credPath,
        JSON.stringify(data, null, 2),
        'utf-8',
      );
    });
  });

  describe('getAgentCredentials()', () => {
    it('returns credentials for a known agent', () => {
      const creds = { token: 'ff_abc', server: 'https://flow.example.com' };
      mockReadFileSync.mockReturnValue(JSON.stringify({
        agents: { 'my-agent': creds },
        default_agent: 'my-agent',
      }));

      const result = getAgentCredentials('my-agent');
      expect(result).toEqual(creds);
    });

    it('returns null for an unknown agent', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        agents: {},
        default_agent: null,
      }));

      const result = getAgentCredentials('unknown-agent');
      expect(result).toBeNull();
    });
  });

  describe('setAgentCredentials()', () => {
    it('saves credentials for a new agent and sets as default', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        agents: {},
        default_agent: null,
      }));

      const creds = { token: 'ff_xyz', server: 'https://flow.example.com' };
      setAgentCredentials('new-agent', creds);

      const writtenData = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
      expect(writtenData.agents['new-agent']).toEqual(creds);
      expect(writtenData.default_agent).toBe('new-agent');
    });

    it('preserves existing agents when adding a new one', () => {
      const existing = {
        agents: {
          'agent-1': { token: 'ff_a', server: 'https://s1.com' },
        },
        default_agent: 'agent-1',
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(existing));

      setAgentCredentials('agent-2', { token: 'ff_b', server: 'https://s2.com' });

      const writtenData = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
      expect(writtenData.agents['agent-1']).toEqual({ token: 'ff_a', server: 'https://s1.com' });
      expect(writtenData.agents['agent-2']).toEqual({ token: 'ff_b', server: 'https://s2.com' });
      // default_agent stays as agent-1 (first registered)
      expect(writtenData.default_agent).toBe('agent-1');
    });

    it('overwrites credentials for an existing agent', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        agents: { 'my-agent': { token: 'ff_old', server: 'https://old.com' } },
        default_agent: 'my-agent',
      }));

      setAgentCredentials('my-agent', { token: 'ff_new', server: 'https://new.com' });

      const writtenData = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
      expect(writtenData.agents['my-agent']).toEqual({ token: 'ff_new', server: 'https://new.com' });
    });
  });
});
