import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildChildEnvironment, withClaimGitHubToken } from '../../src/environment.js';

const SOURCE = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin',
  Path: 'C:\\Windows\\System32',
  HOME: '/home/runner',
  USERPROFILE: 'C:\\Users\\runner',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  TMPDIR: '/tmp/runner',
  TMP: '/tmp',
  TEMP: 'C:\\Temp',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TERM: 'xterm-256color',
  ANTHROPIC_API_KEY: 'unselected-anthropic-secret',
  OPENAI_API_KEY: 'unselected-openai-secret',
  GITHUB_TOKEN: 'host-github-secret',
  FLUENT_FLOW_TOKEN: 'control-plane-secret',
  DATABASE_URL: 'postgres://database-secret',
  UNRELATED_HOST_SECRET: 'unrelated-secret',
});

const PORTABLE_BASICS = {
  PATH: '/usr/local/bin:/usr/bin',
  Path: 'C:\\Windows\\System32',
  HOME: '/home/runner',
  USERPROFILE: 'C:\\Users\\runner',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  TMPDIR: '/tmp/runner',
  TMP: '/tmp',
  TEMP: 'C:\\Temp',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TERM: 'xterm-256color',
};

function windowsRoot() {
  return process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
}

describe('buildChildEnvironment', () => {
  it('copies only portable launch basics and explicitly selected provider values', () => {
    const providerEnvironment = Object.freeze({
      OPENAI_API_KEY: 'selected-openai-secret',
      OPENAI_CONFIG_DIR: '/provider/openai',
    });

    const environment = buildChildEnvironment({ source: SOURCE, providerEnvironment, platform: 'linux' });

    expect(environment).toEqual({
      ...PORTABLE_BASICS,
      OPENAI_API_KEY: 'selected-openai-secret',
      OPENAI_CONFIG_DIR: '/provider/openai',
    });
    expect(environment).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(environment).not.toHaveProperty('UNRELATED_HOST_SECRET');
    expect(environment).not.toHaveProperty('FLUENT_FLOW_TOKEN');
    expect(environment).not.toHaveProperty('DATABASE_URL');
    expect(environment).not.toHaveProperty('GITHUB_TOKEN');
    expect(SOURCE.OPENAI_API_KEY).toBe('unselected-openai-secret');
  });

  it('supports an omitted provider environment without inheriting host credentials', () => {
    expect(buildChildEnvironment({ source: SOURCE, platform: 'linux' })).toEqual(PORTABLE_BASICS);
  });

  it.each([
    'FLUENT_FLOW_SERVER',
    'FLUENT_FLOW_TOKEN',
    'FLUENT_FLOW_ENROLLMENT_TOKEN',
    'fluent_flow_token',
    'Database_Url',
    'DATABASE_URL',
    'PGPASSWORD',
    'PGHOST',
    'PGUSER',
    'POSTGRES_PASSWORD',
    'POSTGRES_USER',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'github_token',
    'GIT_ASKPASS',
    'git_askpass',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_SSH_COMMAND',
    'SSH_AUTH_SOCK',
    'ssh_auth_sock',
  ])('rejects reserved provider key %s', (reservedKey) => {
    expect(() => buildChildEnvironment({
      source: SOURCE,
      providerEnvironment: { [reservedKey]: 'must-not-cross-boundary' },
      platform: 'linux',
    })).toThrow();
    expect(() => buildChildEnvironment({
      source: SOURCE,
      providerEnvironment: { [reservedKey]: 'must-not-cross-boundary' },
      platform: 'win32',
    })).toThrow();
  });

  it('defaults to the host platform', () => {
    expect(buildChildEnvironment({ source: { PATH: '/bin', Path: '/other', OTHER: 'x' } })).toEqual(
      process.platform === 'win32' ? { PATH: '/bin' } : { PATH: '/bin', Path: '/other' },
    );
  });

  describe('on win32', () => {
    it('matches launch basics case-insensitively and keeps the original key casing', () => {
      const source = {
        Path: 'C:\\Windows\\System32',
        SYSTEMROOT: 'C:\\Windows',
        comspec: 'C:\\Windows\\System32\\cmd.exe',
        PathExt: '.COM;.EXE;.CMD',
        Temp: 'C:\\Temp',
        UserProfile: 'C:\\Users\\runner',
        ANTHROPIC_API_KEY: 'unselected-anthropic-secret',
        GitHub_Token: 'host-github-secret',
        UNRELATED_HOST_SECRET: 'unrelated-secret',
      };

      expect(buildChildEnvironment({
        source,
        providerEnvironment: { CLAUDE_CODE_OAUTH_TOKEN: 'selected' },
        platform: 'win32',
      })).toEqual({
        Path: 'C:\\Windows\\System32',
        SYSTEMROOT: 'C:\\Windows',
        comspec: 'C:\\Windows\\System32\\cmd.exe',
        PathExt: '.COM;.EXE;.CMD',
        Temp: 'C:\\Temp',
        UserProfile: 'C:\\Users\\runner',
        CLAUDE_CODE_OAUTH_TOKEN: 'selected',
      });
    });

    it('never emits two spellings of the same variable', () => {
      const environment = buildChildEnvironment({
        source: { PATH: 'C:\\first', Path: 'C:\\second', path: 'C:\\third' },
        platform: 'win32',
      });

      expect(environment).toEqual({ PATH: 'C:\\first' });
    });
  });
});

describe('withClaimGitHubToken', () => {
  it('returns a new claim environment without mutating its base', () => {
    const baseEnvironment = Object.freeze({ PATH: '/portable/bin', HOME: '/slot/home' });

    const environment = withClaimGitHubToken(baseEnvironment, 'claim-github-token');

    expect(environment).not.toBe(baseEnvironment);
    expect(environment).toEqual(expect.objectContaining({
      PATH: '/portable/bin',
      HOME: '/slot/home',
      GH_TOKEN: 'claim-github-token',
      GITHUB_TOKEN: 'claim-github-token',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: expect.any(String),
    }));
    expect(baseEnvironment).toEqual({ PATH: '/portable/bin', HOME: '/slot/home' });
  });

  it('authenticates raw Git HTTPS commands without loading host global or system configuration', () => {
    const home = mkdtempSync(join(tmpdir(), 'ff-claim-git-home-'));
    const systemConfig = join(home, 'system.gitconfig');
    writeFileSync(join(home, '.gitconfig'), [
      '[credential]',
      '  helper = !exit 92',
      '[url "ssh://host-key.example/"]',
      '  insteadOf = https://github.com/',
      '',
    ].join('\n'));
    writeFileSync(systemConfig, [
      '[credential]',
      '  helper = !exit 93',
      '[url "ssh://system-key.example/"]',
      '  insteadOf = https://github.com/',
      '',
    ].join('\n'));
    const baseEnvironment = Object.freeze({
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_SYSTEM: systemConfig,
    });
    const hostEnvironment = { ...baseEnvironment, ...windowsRoot() };

    try {
      const environment = withClaimGitHubToken(hostEnvironment, 'ghp_plaintext_claim_token');
      const gitOptions = { env: environment, encoding: 'utf8' };
      const extraHeader = spawnSync(
        'git',
        ['config', '--get-urlmatch', 'http.extraheader', 'https://github.com/fluent-io/fluent-flow.git'],
        gitOptions,
      );
      const credentialHelpers = spawnSync('git', ['config', '--get-all', 'credential.helper'], gitOptions);
      const urlRewrites = spawnSync('git', ['config', '--get-regexp', '^url\\..*\\.insteadof$'], gitOptions);

      expect(extraHeader.status).toBe(0);
      expect(extraHeader.stdout.trim()).toBe(
        'Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hwX3BsYWludGV4dF9jbGFpbV90b2tlbg==',
      );
      expect(credentialHelpers.status).toBe(1);
      expect(credentialHelpers.stdout).toBe('');
      expect(urlRewrites.status).toBe(1);
      expect(urlRewrites.stdout).toBe('');
      expect(environment).toEqual(expect.objectContaining({
        GH_TOKEN: 'ghp_plaintext_claim_token',
        GITHUB_TOKEN: 'ghp_plaintext_claim_token',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: expect.any(String),
      }));
      expect(environment.GIT_CONFIG_GLOBAL).not.toBe(join(home, '.gitconfig'));
      for (const [name, value] of Object.entries(environment)) {
        if (name === 'GH_TOKEN' || name === 'GITHUB_TOKEN') continue;
        expect(String(value)).not.toContain('ghp_plaintext_claim_token');
      }
      expect(baseEnvironment).toEqual({
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_SYSTEM: systemConfig,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('commits in a fresh repository with a stable claim-scoped agent identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'ff-claim-git-identity-'));
    const home = join(root, 'home');
    const repository = join(root, 'repository');
    const systemConfig = join(root, 'system.gitconfig');
    mkdirSync(home);
    mkdirSync(repository);
    writeFileSync(join(home, '.gitconfig'), [
      '[user]',
      '  name = Host Global User',
      '  email = host-global@example.test',
      '',
    ].join('\n'));
    writeFileSync(systemConfig, [
      '[user]',
      '  name = Host System User',
      '  email = host-system@example.test',
      '',
    ].join('\n'));
    const environment = withClaimGitHubToken({
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_SYSTEM: systemConfig,
      ...windowsRoot(),
    }, 'ghp_identity_regression_secret');
    const gitOptions = { cwd: repository, env: environment, encoding: 'utf8' };

    try {
      expect(spawnSync('git', ['init'], gitOptions).status).toBe(0);
      expect(spawnSync('git', ['config', '--local', 'user.useConfigOnly', 'true'], gitOptions).status).toBe(0);
      writeFileSync(join(repository, 'claim.txt'), 'claim output\n');
      expect(spawnSync('git', ['add', 'claim.txt'], gitOptions).status).toBe(0);

      const commit = spawnSync('git', ['commit', '-m', 'Claim output'], gitOptions);

      expect(commit.status).toBe(0);
      const identity = spawnSync(
        'git',
        ['log', '-1', '--format=%an%x00%ae%x00%cn%x00%ce'],
        gitOptions,
      );
      expect(identity.status).toBe(0);
      expect(identity.stdout.trim().split('\0')).toEqual([
        'Fluent Flow Agent',
        'agent@fluentflow.invalid',
        'Fluent Flow Agent',
        'agent@fluentflow.invalid',
      ]);
      expect(identity.stdout).not.toContain('Host Global User');
      expect(identity.stdout).not.toContain('Host System User');
      expect(identity.stdout).not.toContain('ghp_identity_regression_secret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the POSIX null device for global Git configuration', () => {
    const environment = withClaimGitHubToken({ PATH: '/portable/bin' }, 'claim-github-token', { platform: 'linux' });

    expect(environment.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(environment.GIT_CONFIG_COUNT).toBe('1');
    expect(environment.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    expect(environment).not.toHaveProperty('GIT_CONFIG_KEY_1');
  });

  it('uses the Windows null device and long paths on win32 while keeping the claim token header first', () => {
    const environment = withClaimGitHubToken({ Path: 'C:\\Windows' }, 'claim-github-token', { platform: 'win32' });

    expect(environment.GIT_CONFIG_GLOBAL).toBe('NUL');
    expect(environment.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(environment.GIT_CONFIG_COUNT).toBe('2');
    expect(environment.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    expect(environment.GIT_CONFIG_VALUE_0).toMatch(/^Authorization: Basic /u);
    expect(environment.GIT_CONFIG_KEY_1).toBe('core.longpaths');
    expect(environment.GIT_CONFIG_VALUE_1).toBe('true');
  });

  it('enables long paths on win32 without a claim token and without adding GitHub keys', () => {
    const environment = withClaimGitHubToken({ Path: 'C:\\Windows' }, undefined, { platform: 'win32' });

    expect(environment.GIT_CONFIG_COUNT).toBe('1');
    expect(environment.GIT_CONFIG_KEY_0).toBe('core.longpaths');
    expect(environment.GIT_CONFIG_VALUE_0).toBe('true');
    expect(environment).not.toHaveProperty('GH_TOKEN');
    expect(environment).not.toHaveProperty('GITHUB_TOKEN');
  });

  it('removes inherited Git configuration injection on every platform', () => {
    const inherited = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c', GIT_CONFIG_KEY_1: 'd.e', GIT_CONFIG_VALUE_1: 'f' };
    for (const platform of ['linux', 'win32']) {
      const environment = withClaimGitHubToken(inherited, undefined, { platform });
      expect(environment.GIT_CONFIG_KEY_0).not.toBe('a.b');
      expect(environment).not.toHaveProperty('GIT_CONFIG_KEY_2');
    }
  });

  it.each([undefined, null, ''])('isolates Git without adding GitHub keys when a claim token is not supplied', (githubToken) => {
    const baseEnvironment = Object.freeze({ PATH: '/portable/bin' });
    const environment = withClaimGitHubToken(baseEnvironment, githubToken);

    expect(environment).not.toBe(baseEnvironment);
    expect(environment).toEqual(expect.objectContaining({
      PATH: '/portable/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: expect.any(String),
    }));
    expect(environment).not.toHaveProperty('GH_TOKEN');
    expect(environment).not.toHaveProperty('GITHUB_TOKEN');
  });
});
