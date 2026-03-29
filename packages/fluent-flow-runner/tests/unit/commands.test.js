import { describe, it, expect } from 'vitest';
import { resolveCommand, AGENT_COMMANDS } from '../../src/commands.js';

describe('commands', () => {
  describe('AGENT_COMMANDS', () => {
    it('has entries for claude-code, codex, and aider', () => {
      expect(AGENT_COMMANDS['claude-code']).toBeDefined();
      expect(AGENT_COMMANDS['codex']).toBeDefined();
      expect(AGENT_COMMANDS['aider']).toBeDefined();
    });
  });

  describe('resolveCommand()', () => {
    it('returns claude-code command with prompt substituted', () => {
      const cmd = resolveCommand({ agentType: 'claude-code', prompt: 'fix the bug' });
      expect(cmd).toContain('claude');
      expect(cmd).toContain('fix the bug');
      expect(cmd).toContain('--allowedTools');
    });

    it('returns codex command with prompt substituted', () => {
      const cmd = resolveCommand({ agentType: 'codex', prompt: 'fix it' });
      expect(cmd).toContain('codex');
      expect(cmd).toContain('fix it');
      expect(cmd).toContain('--approval-mode full-auto');
    });

    it('returns aider command with prompt substituted', () => {
      const cmd = resolveCommand({ agentType: 'aider', prompt: 'fix it' });
      expect(cmd).toContain('aider');
      expect(cmd).toContain('fix it');
      expect(cmd).toContain('--yes');
    });

    it('uses CLI override when provided', () => {
      const cmd = resolveCommand({
        agentType: 'claude-code',
        prompt: 'do stuff',
        commandOverride: 'my-agent --auto "{prompt}"',
      });
      expect(cmd).toBe('my-agent --auto "do stuff"');
    });

    it('uses transport_meta.command when provided (no CLI override)', () => {
      const cmd = resolveCommand({
        agentType: 'custom',
        prompt: 'hello',
        transportCommand: 'custom-tool -p "{prompt}"',
      });
      expect(cmd).toBe('custom-tool -p "hello"');
    });

    it('CLI override takes precedence over transport_meta.command', () => {
      const cmd = resolveCommand({
        agentType: 'custom',
        prompt: 'hello',
        transportCommand: 'transport-cmd "{prompt}"',
        commandOverride: 'override-cmd "{prompt}"',
      });
      expect(cmd).toBe('override-cmd "hello"');
    });

    it('throws for unknown agent_type with no override or transport command', () => {
      expect(() => resolveCommand({ agentType: 'unknown', prompt: 'x' }))
        .toThrow('No command template for agent type "unknown"');
    });

    it('escapes double quotes in prompt', () => {
      const cmd = resolveCommand({ agentType: 'claude-code', prompt: 'fix "this" bug' });
      expect(cmd).toContain('fix \\"this\\" bug');
      expect(cmd).not.toContain('fix "this" bug');
    });
  });
});
