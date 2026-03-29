import { describe, it, expect } from 'vitest';
import { resolveCommand, AGENT_COMMANDS, escapeForShell } from '../../src/commands.js';

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

  describe('resolveCommand() — custom templates', () => {
    it('uses CLI override and returns { shell }', () => {
      const cmd = resolveCommand({
        agentType: 'claude-code',
        prompt: 'do stuff',
        commandOverride: 'my-agent --auto "{prompt}"',
      });
      expect(cmd.shell).toBe('my-agent --auto "do stuff"');
      expect(cmd).not.toHaveProperty('bin');
    });

    it('uses transport_meta.command when provided (no CLI override)', () => {
      const cmd = resolveCommand({
        agentType: 'custom',
        prompt: 'hello',
        transportCommand: 'custom-tool -p "{prompt}"',
      });
      expect(cmd.shell).toBe('custom-tool -p "hello"');
    });

    it('CLI override takes precedence over transport_meta.command', () => {
      const cmd = resolveCommand({
        agentType: 'custom',
        prompt: 'hello',
        transportCommand: 'transport-cmd "{prompt}"',
        commandOverride: 'override-cmd "{prompt}"',
      });
      expect(cmd.shell).toBe('override-cmd "hello"');
    });

    it('escapes shell metacharacters in custom template prompts', () => {
      const cmd = resolveCommand({
        agentType: 'custom',
        prompt: 'fix $(rm -rf /) and `whoami`',
        commandOverride: 'agent "{prompt}"',
      });
      // $ and backticks should be escaped with backslashes
      expect(cmd.shell).toContain('\\$');
      expect(cmd.shell).toContain('\\`');
      // The unescaped forms should not appear (check exact sequences)
      expect(cmd.shell).not.toMatch(/[^\\]\$\(/);  // no unescaped $(
      expect(cmd.shell).not.toMatch(/[^\\]`/);       // no unescaped `
    });
  });

  describe('resolveCommand() — errors', () => {
    it('throws for unknown agent_type with no override or transport command', () => {
      expect(() => resolveCommand({ agentType: 'unknown', prompt: 'x' }))
        .toThrow('No command template for agent type "unknown"');
    });
  });

  describe('escapeForShell()', () => {
    it('escapes double quotes', () => {
      expect(escapeForShell('say "hi"')).toBe('say \\"hi\\"');
    });

    it('escapes backticks', () => {
      expect(escapeForShell('run `cmd`')).toBe('run \\`cmd\\`');
    });

    it('escapes dollar signs', () => {
      expect(escapeForShell('$HOME')).toBe('\\$HOME');
    });

    it('escapes backslashes', () => {
      expect(escapeForShell('path\\to')).toBe('path\\\\to');
    });

    it('escapes newlines', () => {
      expect(escapeForShell('line1\nline2')).toBe('line1\\nline2');
    });
  });
});
