import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveCommand, AGENT_COMMANDS, MAX_PROMPT_LENGTH } from '../../src/commands.js';

const originalPlatform = process.platform;

describe('commands', () => {
  describe('AGENT_COMMANDS', () => {
    it('has entries for claude-code, codex, and aider', () => {
      expect(AGENT_COMMANDS['claude-code']).toBeDefined();
      expect(AGENT_COMMANDS['codex']).toBeDefined();
      expect(AGENT_COMMANDS['aider']).toBeDefined();
    });
  });

  describe('resolveCommand() — built-in agent types', () => {
    it('returns { bin, args } for claude-code with prompt as discrete arg', () => {
      const cmd = resolveCommand({ agentType: 'claude-code', prompt: 'fix the bug' });
      expect(cmd.bin).toBe('claude');
      expect(cmd.args).toContain('-p');
      expect(cmd.args).toContain('fix the bug');
      expect(cmd.args).toContain('--allowedTools');
      expect(cmd).not.toHaveProperty('shell');
    });

    it('returns { bin, args } for codex', () => {
      const cmd = resolveCommand({ agentType: 'codex', prompt: 'fix it' });
      expect(cmd.bin).toBe('codex');
      expect(cmd.args).toContain('fix it');
      expect(cmd.args).toContain('--approval-mode');
      expect(cmd.args).toContain('full-auto');
    });

    it('returns { bin, args } for aider', () => {
      const cmd = resolveCommand({ agentType: 'aider', prompt: 'fix it' });
      expect(cmd.bin).toBe('aider');
      expect(cmd.args).toContain('fix it');
      expect(cmd.args).toContain('--yes');
    });

    it('passes prompt with shell metacharacters safely as a discrete arg', () => {
      const prompt = 'fix $(rm -rf /) and `whoami` with $HOME';
      const cmd = resolveCommand({ agentType: 'claude-code', prompt });
      expect(cmd.args).toContain(prompt);
      expect(cmd).not.toHaveProperty('shell');
    });
  });

  describe('resolveCommand() — custom templates (env-var based)', () => {
    it('uses CLI override and returns { shell, env }', () => {
      const cmd = resolveCommand({
        agentType: 'claude-code',
        prompt: 'do stuff',
        commandOverride: 'my-agent --auto "{prompt}"',
      });
      expect(cmd.env).toEqual({ FLUENT_FLOW_PROMPT: 'do stuff' });
      expect(cmd).not.toHaveProperty('bin');
      // {prompt} is replaced with env var reference, not the raw prompt
      expect(cmd.shell).not.toContain('do stuff');
      expect(cmd.shell).toContain('FLUENT_FLOW_PROMPT');
    });

    it('uses transport_meta.command when provided (no CLI override)', () => {
      const cmd = resolveCommand({
        agentType: 'custom',
        prompt: 'hello',
        transportCommand: 'custom-tool -p "{prompt}"',
      });
      expect(cmd.env).toEqual({ FLUENT_FLOW_PROMPT: 'hello' });
      expect(cmd.shell).toContain('FLUENT_FLOW_PROMPT');
    });

    it('CLI override takes precedence over transport_meta.command', () => {
      const cmd = resolveCommand({
        agentType: 'custom',
        prompt: 'hello',
        transportCommand: 'transport-cmd "{prompt}"',
        commandOverride: 'override-cmd "{prompt}"',
      });
      expect(cmd.shell).toMatch(/^override-cmd /);
      expect(cmd.env).toEqual({ FLUENT_FLOW_PROMPT: 'hello' });
    });

    it('prevents shell injection by passing prompt via env var, not interpolation', () => {
      const malicious = 'fix $(rm -rf /) && `whoami` | cat /etc/passwd; echo pwned';
      const cmd = resolveCommand({
        agentType: 'custom',
        prompt: malicious,
        commandOverride: 'agent "{prompt}"',
      });
      // The raw malicious string must NOT appear in the shell command
      expect(cmd.shell).not.toContain(malicious);
      expect(cmd.shell).not.toContain('$(rm');
      expect(cmd.shell).not.toContain('`whoami`');
      // It is safely passed via environment
      expect(cmd.env.FLUENT_FLOW_PROMPT).toBe(malicious);
    });
  });

  describe('resolveCommand() — Windows platform', () => {
    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('uses %VAR% syntax for custom templates on win32', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const cmd = resolveCommand({
        agentType: 'custom',
        prompt: 'fix it',
        commandOverride: 'my-agent "{prompt}"',
      });
      expect(cmd.shell).toBe('my-agent "%FLUENT_FLOW_PROMPT%"');
      expect(cmd.env).toEqual({ FLUENT_FLOW_PROMPT: 'fix it' });
    });

    it('uses $VAR syntax for custom templates on linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const cmd = resolveCommand({
        agentType: 'custom',
        prompt: 'fix it',
        commandOverride: 'my-agent "{prompt}"',
      });
      expect(cmd.shell).toBe('my-agent ""$FLUENT_FLOW_PROMPT""');
      expect(cmd.env).toEqual({ FLUENT_FLOW_PROMPT: 'fix it' });
    });

    it('replaces multiple {prompt} placeholders with Windows env var syntax', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const cmd = resolveCommand({
        agentType: 'custom',
        prompt: 'hello',
        commandOverride: 'agent --msg {prompt} --confirm {prompt}',
      });
      expect(cmd.shell).toBe('agent --msg %FLUENT_FLOW_PROMPT% --confirm %FLUENT_FLOW_PROMPT%');
    });
  });

  describe('resolveCommand() — errors', () => {
    it('throws for unknown agent_type with no override or transport command', () => {
      expect(() => resolveCommand({ agentType: 'unknown', prompt: 'x' }))
        .toThrow('No command template for agent type "unknown"');
    });

    it('throws when prompt exceeds maximum length', () => {
      const oversized = 'x'.repeat(MAX_PROMPT_LENGTH + 1);
      expect(() => resolveCommand({ agentType: 'claude-code', prompt: oversized }))
        .toThrow('Prompt exceeds maximum length');
    });
  });
});
