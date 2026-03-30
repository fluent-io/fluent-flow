import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../bin/fluent-flow-runner.js';

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

  it('throws if --token is missing', () => {
    expect(() => parseArgs(['--server', 's'])).toThrow('--token is required');
  });

  it('throws if --server is missing', () => {
    expect(() => parseArgs(['--token', 't'])).toThrow('--server is required');
  });
});
