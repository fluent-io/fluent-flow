import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/parse-args.js';

const required = ['--token', 'ff_test', '--server', 'https://flow.example.com'];

describe('CLI parseArgs()', () => {
  it('parses existing runner options', () => {
    expect(parseArgs([...required, '--cwd', '/repo', '--verbose', '--agent', 'local-agent', '--mcp-auth-token', 'mcp_test'])).toMatchObject({
      token: 'ff_test',
      server: 'https://flow.example.com',
      cwd: '/repo',
      verbose: true,
      agent: 'local-agent',
      mcpAuthToken: 'mcp_test',
    });
  });

  it('defaults verbose and ACP arguments', () => {
    expect(parseArgs(required)).toMatchObject({ verbose: false, acpArgs: [] });
  });

  it('allows saved agent credentials instead of a token', () => {
    expect(parseArgs(['--server', 's', '--agent', 'local-agent'])).toMatchObject({ agent: 'local-agent', server: 's' });
  });

  it('parses a local ACP command with repeatable literal arguments', () => {
    const options = parseArgs([...required, '--acp-command', '/opt/bin/agent', '--acp-arg', '--stdio', '--acp-arg', 'profile name']);
    expect(options.acpCommand).toBe('/opt/bin/agent');
    expect(options.acpArgs).toEqual(['--stdio', 'profile name']);
  });

  it('rejects the removed command template flag with migration guidance', () => {
    expect(() => parseArgs([...required, '--command', 'claude -p "{prompt}"'])).toThrow(/--command.*--acp-command/i);
  });

  it('rejects unknown flags instead of silently ignoring them', () => {
    expect(() => parseArgs([...required, '--acp-comand', 'agent'])).toThrow(/unknown.*--acp-comand/i);
  });

  it.each(['--token', '--server', '--cwd', '--agent', '--mcp-auth-token', '--acp-command', '--acp-arg'])('rejects a missing value for %s', (flag) => {
    expect(() => parseArgs([...required, flag])).toThrow(new RegExp(`${flag}.*value`, 'i'));
  });

  it.each(['--token', '--server', '--cwd', '--agent', '--mcp-auth-token', '--acp-command'])('does not consume the next flag as the value for %s', (flag) => {
    expect(() => parseArgs([...required, flag, '--verbose'])).toThrow(new RegExp(`${flag}.*value`, 'i'));
  });

  it('accepts a flag-shaped ACP argument literally', () => {
    expect(parseArgs([...required, '--acp-command', 'agent', '--acp-arg', '--stdio']).acpArgs).toEqual(['--stdio']);
  });

  it('requires either token or agent', () => {
    expect(() => parseArgs(['--server', 's'])).toThrow('--token or --agent is required');
  });

  it('requires server', () => {
    expect(() => parseArgs(['--token', 't'])).toThrow('--server is required');
  });
});
