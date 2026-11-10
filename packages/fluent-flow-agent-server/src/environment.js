const PORTABLE_ENVIRONMENT_KEYS = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TERM',
];

const PORTABLE_ENVIRONMENT_NAMES = new Set(PORTABLE_ENVIRONMENT_KEYS.map((key) => key.toUpperCase()));

function nullDevice(platform) {
  return platform === 'win32' ? 'NUL' : '/dev/null';
}

function portableEnvironment(source, platform) {
  const environment = {};
  if (platform === 'win32') {
    const seen = new Set();
    for (const key of Object.keys(source)) {
      const name = key.toUpperCase();
      if (!PORTABLE_ENVIRONMENT_NAMES.has(name) || seen.has(name) || source[key] === undefined) continue;
      seen.add(name);
      environment[key] = source[key];
    }
    return environment;
  }
  for (const key of PORTABLE_ENVIRONMENT_KEYS) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}

function isReservedProviderKey(key) {
  const normalized = key.toUpperCase();
  return (
    normalized === 'FLUENT_FLOW'
    || normalized.startsWith('FLUENT_FLOW_')
    || normalized === 'CONTROL_PLANE'
    || normalized.startsWith('CONTROL_PLANE_')
    || normalized === 'DATABASE_URL'
    || normalized.startsWith('DATABASE_')
    || normalized.startsWith('DB_')
    || normalized === 'PG'
    || normalized.startsWith('PG')
    || normalized === 'POSTGRES'
    || normalized.startsWith('POSTGRES_')
    || normalized === 'GH'
    || normalized.startsWith('GH_')
    || normalized === 'GITHUB'
    || normalized.startsWith('GITHUB_')
    || normalized === 'GIT'
    || normalized.startsWith('GIT_')
    || normalized === 'SSH_AUTH_SOCK'
    || normalized === 'SSH_AGENT_PID'
  );
}

export function buildChildEnvironment({
  source = process.env,
  providerEnvironment,
  platform = process.platform,
} = {}) {
  const environment = portableEnvironment(source, platform);
  for (const [key, value] of Object.entries(providerEnvironment ?? {})) {
    if (isReservedProviderKey(key)) {
      throw new Error(`Provider environment key is reserved: ${key}`);
    }
    environment[key] = value;
  }
  return environment;
}

export function withClaimGitHubToken(baseEnvironment, githubToken, { platform = process.platform } = {}) {
  const environment = { ...baseEnvironment };
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/u.test(key)) delete environment[key];
  }
  delete environment.GH_TOKEN;
  delete environment.GITHUB_TOKEN;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = nullDevice(platform);
  environment.GIT_AUTHOR_NAME = 'Fluent Flow Agent';
  environment.GIT_AUTHOR_EMAIL = 'agent@fluentflow.invalid';
  environment.GIT_COMMITTER_NAME = 'Fluent Flow Agent';
  environment.GIT_COMMITTER_EMAIL = 'agent@fluentflow.invalid';
  const gitConfig = [];
  if (typeof githubToken === 'string' && githubToken.length > 0) {
    const authorization = Buffer.from(`x-access-token:${githubToken}`, 'utf8').toString('base64');
    environment.GH_TOKEN = githubToken;
    environment.GITHUB_TOKEN = githubToken;
    gitConfig.push(['http.https://github.com/.extraheader', `Authorization: Basic ${authorization}`]);
  }
  if (platform === 'win32') gitConfig.push(['core.longpaths', 'true']);
  environment.GIT_CONFIG_COUNT = String(gitConfig.length);
  gitConfig.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}
