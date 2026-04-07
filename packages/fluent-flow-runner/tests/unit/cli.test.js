import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../src/parse-args.js';

describe('CLI parseArgs()', () => {
  it('parses --token and --server', () => {
    const opts = parseArgs(['--token', 'ff_abc', '--server', 'https://flow.example.com']);
    expect(opts.token).toBe('ff_abc');
    expect(opts.server).toBe('https://flow.example.com');
  });

  it('parses --command override', () => {
    const opts = parseArgs(['--token', 't', '--server', 's', '--command', 'my-agent "{prompt}"']);
    expect(opts.command).toBe('my-agent "{prompt}"');
  });

  it('parses --cwd', () => {
    const opts = parseArgs(['--token', 't', '--server', 's', '--cwd', '/repos/myapp']);
    expect(opts.cwd).toBe('/repos/myapp');
  });

  it('parses --verbose', () => {
    const opts = parseArgs(['--token', 't', '--server', 's', '--verbose']);
    expect(opts.verbose).toBe(true);
  });

  it('defaults verbose to false', () => {
    const opts = parseArgs(['--token', 't', '--server', 's']);
    expect(opts.verbose).toBe(false);
  });

  it('parses --agent flag', () => {
    const opts = parseArgs(['--token', 't', '--server', 's', '--agent', 'my-agent']);
    expect(opts.agent).toBe('my-agent');
  });

  it('parses --mcp-auth-token flag', () => {
    const opts = parseArgs(['--token', 't', '--server', 's', '--mcp-auth-token', 'mcp_secret']);
    expect(opts.mcpAuthToken).toBe('mcp_secret');
  });

  it('token is optional when agent is provided with mcp-auth-token', () => {
    const opts = parseArgs(['--server', 's', '--agent', 'my-agent', '--mcp-auth-token', 'mcp_tok']);
    expect(opts.token).toBeUndefined();
    expect(opts.agent).toBe('my-agent');
  });

  it('throws if --agent is provided without --token and --mcp-auth-token', () => {
    expect(() => parseArgs(['--server', 's', '--agent', 'my-agent']))
      .toThrow('--agent requires --mcp-auth-token or --token');
  });

  it('allows --agent with --token (no mcp-auth-token needed)', () => {
    const opts = parseArgs(['--server', 's', '--agent', 'my-agent', '--token', 'ff_tok']);
    expect(opts.agent).toBe('my-agent');
    expect(opts.token).toBe('ff_tok');
  });

  it('throws if neither --token nor --agent is provided', () => {
    expect(() => parseArgs(['--server', 's'])).toThrow('--token or --agent is required');
  });

  it('throws if --server is missing', () => {
    expect(() => parseArgs(['--token', 't'])).toThrow('--server is required');
  });
});
