import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

// Mock node:os
const mockHomedir = vi.fn(() => '/home/testuser');
vi.mock('node:os', () => ({
  homedir: () => mockHomedir(),
  hostname: () => 'testhost',
}));

// Mock node:fs
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
        _encryption: { salt: 'c2FsdA==' },
        agents: {
          'my-agent': { token: { iv: 'aQ==', data: 'Yg==', tag: 'Yw==' }, server: 'https://flow.example.com' },
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

    it('rethrows EACCES permission errors', () => {
      const error = new Error('EACCES: permission denied');
      error.code = 'EACCES';
      mockReadFileSync.mockImplementation(() => { throw error; });

      expect(() => loadCredentials()).toThrow('EACCES');
    });

    it('rethrows I/O errors', () => {
      const error = new Error('EIO: i/o error');
      error.code = 'EIO';
      mockReadFileSync.mockImplementation(() => { throw error; });

      expect(() => loadCredentials()).toThrow('EIO');
    });

    it('normalizes agents field when missing', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ default_agent: 'x' }));

      const result = loadCredentials();
      expect(result.agents).toEqual({});
      expect(result.default_agent).toBe('x');
    });

    it('normalizes agents field when null', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ agents: null, default_agent: null }));

      const result = loadCredentials();
      expect(result.agents).toEqual({});
    });

    it('normalizes agents field when not an object', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ agents: 'bad', default_agent: null }));

      const result = loadCredentials();
      expect(result.agents).toEqual({});
    });
  });

  describe('saveCredentials()', () => {
    it('writes credentials JSON with restricted directory and file permissions', () => {
      const data = { agents: {}, default_agent: null, _encryption: { salt: 'abc' } };
      saveCredentials(data);

      expect(mockMkdirSync).toHaveBeenCalledWith(credDir, { recursive: true, mode: 0o700 });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        credPath,
        JSON.stringify(data, null, 2),
        { encoding: 'utf-8', mode: 0o600 },
      );
    });
  });

  describe('encryption round-trip', () => {
    it('encrypts tokens on save and decrypts on load', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ agents: {}, default_agent: null }));

      setAgentCredentials('test-agent', { token: 'ff_secret_token', server: 'https://flow.example.com' });

      // Capture what was written
      const writtenData = JSON.parse(mockWriteFileSync.mock.calls[0][1]);

      // Verify token is NOT plaintext
      expect(writtenData.agents['test-agent'].token).not.toBe('ff_secret_token');
      expect(writtenData.agents['test-agent'].token.data).toBeDefined();
      expect(writtenData.agents['test-agent'].token.iv).toBeDefined();
      expect(writtenData.agents['test-agent'].token.tag).toBeDefined();
      expect(writtenData.agents['test-agent'].server).toBe('https://flow.example.com');

      // Verify encryption salt exists
      expect(writtenData._encryption.salt).toBeDefined();

      // Load: mock file to return what was written
      mockReadFileSync.mockReturnValue(JSON.stringify(writtenData));

      const result = getAgentCredentials('test-agent');
      expect(result).toEqual({ token: 'ff_secret_token', server: 'https://flow.example.com' });
    });

    it('preserves encryption salt across multiple saves', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ agents: {}, default_agent: null }));

      setAgentCredentials('agent-1', { token: 'ff_tok1', server: 'https://s1.com' });
      const firstWrite = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
      const salt = firstWrite._encryption.salt;

      // Second save uses same file content
      mockReadFileSync.mockReturnValue(JSON.stringify(firstWrite));
      setAgentCredentials('agent-2', { token: 'ff_tok2', server: 'https://s2.com' });

      const secondWrite = JSON.parse(mockWriteFileSync.mock.calls[1][1]);
      expect(secondWrite._encryption.salt).toBe(salt);
    });

    it('uses unique IVs for each encryption', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ agents: {}, default_agent: null }));

      setAgentCredentials('agent-1', { token: 'ff_tok1', server: 'https://s1.com' });
      const firstWrite = JSON.parse(mockWriteFileSync.mock.calls[0][1]);

      mockReadFileSync.mockReturnValue(JSON.stringify(firstWrite));
      setAgentCredentials('agent-2', { token: 'ff_tok2', server: 'https://s2.com' });
      const secondWrite = JSON.parse(mockWriteFileSync.mock.calls[1][1]);

      // IVs must differ even for same plaintext
      expect(firstWrite.agents['agent-1'].token.iv).not.toBe(secondWrite.agents['agent-2'].token.iv);
    });
  });

  describe('getAgentCredentials()', () => {
    it('returns null for an unknown agent', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        _encryption: { salt: 'c2FsdA==' },
        agents: {},
        default_agent: null,
      }));

      const result = getAgentCredentials('unknown-agent');
      expect(result).toBeNull();
    });

    it('returns null when encryption salt is missing', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        agents: { 'my-agent': { token: { iv: 'aQ==', data: 'Yg==', tag: 'Yw==' }, server: 'https://s.com' } },
        default_agent: 'my-agent',
      }));

      const result = getAgentCredentials('my-agent');
      expect(result).toBeNull();
    });

    it('returns null when encrypted token data is malformed', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        _encryption: { salt: 'c2FsdA==' },
        agents: { 'my-agent': { token: 'plaintext-token', server: 'https://s.com' } },
        default_agent: 'my-agent',
      }));

      const result = getAgentCredentials('my-agent');
      expect(result).toBeNull();
    });
  });

  describe('setAgentCredentials()', () => {
    it('saves encrypted credentials for a new agent and sets as default', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        agents: {},
        default_agent: null,
      }));

      setAgentCredentials('new-agent', { token: 'ff_xyz', server: 'https://flow.example.com' });

      const writtenData = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
      expect(writtenData.agents['new-agent'].token.data).toBeDefined();
      expect(writtenData.agents['new-agent'].server).toBe('https://flow.example.com');
      expect(writtenData.default_agent).toBe('new-agent');
    });

    it('preserves existing agents when adding a new one', () => {
      // First save: create agent-1
      mockReadFileSync.mockReturnValue(JSON.stringify({ agents: {}, default_agent: null }));
      setAgentCredentials('agent-1', { token: 'ff_a', server: 'https://s1.com' });
      const firstWrite = JSON.parse(mockWriteFileSync.mock.calls[0][1]);

      // Second save: add agent-2
      mockReadFileSync.mockReturnValue(JSON.stringify(firstWrite));
      setAgentCredentials('agent-2', { token: 'ff_b', server: 'https://s2.com' });

      const secondWrite = JSON.parse(mockWriteFileSync.mock.calls[1][1]);
      expect(secondWrite.agents['agent-1'].token.data).toBeDefined();
      expect(secondWrite.agents['agent-2'].token.data).toBeDefined();
      expect(secondWrite.default_agent).toBe('agent-1');
    });

    it('overwrites credentials for an existing agent', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ agents: {}, default_agent: null }));
      setAgentCredentials('my-agent', { token: 'ff_old', server: 'https://old.com' });
      const firstWrite = JSON.parse(mockWriteFileSync.mock.calls[0][1]);

      mockReadFileSync.mockReturnValue(JSON.stringify(firstWrite));
      setAgentCredentials('my-agent', { token: 'ff_new', server: 'https://new.com' });

      const secondWrite = JSON.parse(mockWriteFileSync.mock.calls[1][1]);
      // Verify the new token can be decrypted
      mockReadFileSync.mockReturnValue(JSON.stringify(secondWrite));
      const result = getAgentCredentials('my-agent');
      expect(result.token).toBe('ff_new');
      expect(result.server).toBe('https://new.com');
    });
  });

  describe('file permissions', () => {
    it('creates directory with mode 0700', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ agents: {}, default_agent: null }));
      setAgentCredentials('agent', { token: 'ff_tok', server: 'https://s.com' });

      expect(mockMkdirSync).toHaveBeenCalledWith(credDir, { recursive: true, mode: 0o700 });
    });

    it('writes file with mode 0600', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ agents: {}, default_agent: null }));
      setAgentCredentials('agent', { token: 'ff_tok', server: 'https://s.com' });

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        credPath,
        expect.any(String),
        expect.objectContaining({ mode: 0o600 }),
      );
    });
  });
});
