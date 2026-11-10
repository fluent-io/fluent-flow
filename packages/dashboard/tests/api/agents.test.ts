import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetServerSession = vi.fn();
const mockListAgents = vi.fn();
const mockCreateAgentWithEnrollment = vi.fn();
const mockCreateAgent = vi.fn();
const mockCreateToken = vi.fn();
const mockQuery = vi.fn();
vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@fluent-flow/db', () => ({
  listAgents: (...args: unknown[]) => mockListAgents(...args),
  createAgentWithEnrollment: (...args: unknown[]) => mockCreateAgentWithEnrollment(...args),
  createAgent: (...args: unknown[]) => mockCreateAgent(...args),
  createToken: (...args: unknown[]) => mockCreateToken(...args),
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
  getOrgScope: vi.fn((session: { user: { isSuperadmin: boolean; orgs: { org_id: string }[] } }) => {
    if (session.user.isSuperadmin) return { orgIds: [], isSuperadmin: true };
    return { orgIds: session.user.orgs.map((o) => o.org_id), isSuperadmin: false };
  }),
  hasRole: vi.fn(() => true),
}));

const { GET, POST } = await import('../../src/app/api/agents/route.js');
const { hasRole } = await import('@/lib/auth');

describe('GET /api/agents', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockListAgents.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);

    const response = await GET();
    expect(response.status).toBe(401);
  });

  it('returns agents scoped to user orgs', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, login: 'victor', isSuperadmin: false, orgs: [{ org_id: 'fluent-io', role: 'admin' }] },
    });
    mockListAgents.mockResolvedValueOnce([
      { id: 'ff-runner', org_id: 'fluent-io', agent_type: 'claude-code', status: 'online' },
    ]);

    const response = await GET();
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('ff-runner');
    expect(mockListAgents).toHaveBeenCalledWith(['fluent-io'], false);
  });

  it('returns all agents for superadmin', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, login: 'victor', isSuperadmin: true, orgs: [] },
    });
    mockListAgents.mockResolvedValueOnce([]);

    const response = await GET();
    expect(response.status).toBe(200);
    expect(mockListAgents).toHaveBeenCalledWith([], true);
  });

  it('passes isSuperadmin=false for empty-org collaborator so legacy agents are not unscoped', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 7, login: 'client-user', isSuperadmin: false, orgs: [] },
    });
    mockListAgents.mockResolvedValueOnce([]);

    const response = await GET();
    expect(response.status).toBe(200);
    expect(mockListAgents).toHaveBeenCalledWith([], false);
  });
});

describe('POST /api/agents', () => {
  const ENROLLMENT_TOKEN = `enroll_${'ab12'.repeat(16)}`;
  const NOW = new Date('2026-11-08T12:00:00.000Z');
  const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
  const SELF_HOSTED_IMAGE = 'ghcr.io/fluent-io/fluent-flow-agent-server:latest';
  const LINE_BREAK = ' \\\n  ';
  const LEGACY_AGENT_TYPE = { agent_type: 'claude-code' };
  const adminSession = {
    user: { id: 1, login: 'victor', isSuperadmin: false, orgs: [{ org_id: 'fluent-io', role: 'admin' }] },
  };

  let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      org_id: 'fluent-io',
      agent_id: 'box-1',
      provider: 'codex',
      capacity: 4,
      deployment: 'local',
      ...overrides,
    };
  }

  function rawRequest(rawBody: string) {
    return new Request('http://localhost/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
    });
  }

  function postRequest(body: unknown) {
    return rawRequest(JSON.stringify(body));
  }

  function commandLines(command: string): string[] {
    return command.split(LINE_BREAK);
  }

  function loggedText(): string {
    return consoleSpies
      .flatMap((spy) => spy.mock.calls.flat())
      .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
      .join('\n');
  }

  function expectNothingCreated() {
    expect(mockCreateAgentWithEnrollment).not.toHaveBeenCalled();
    expect(mockCreateAgent).not.toHaveBeenCalled();
    expect(mockCreateToken).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    process.env.NEXT_PUBLIC_FLUENT_FLOW_URL = 'https://flow.example.com';
    mockGetServerSession.mockResolvedValue(adminSession);
    mockCreateAgentWithEnrollment.mockImplementation(async (input: {
      id: string;
      orgId: string;
      agentType: string;
      transport: string;
      transportMeta: Record<string, unknown>;
    }) => ({
      agent: {
        id: input.id,
        org_id: input.orgId,
        agent_type: input.agentType,
        transport: input.transport,
        transport_meta: input.transportMeta,
        repos: [],
      },
      enrollment: { plaintext: ENROLLMENT_TOKEN, id: 41 },
    }));
  });

  afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  describe('authentication and authorization', () => {
    it('returns 401 before reporting configuration problems or parsing the body', async () => {
      mockGetServerSession.mockResolvedValue(null);
      delete process.env.NEXT_PUBLIC_FLUENT_FLOW_URL;

      const response = await POST(rawRequest('{'));

      expect(response.status).toBe(401);
      expectNothingCreated();
      expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    });

    it('returns 403 when the caller is not an admin of the target org', async () => {
      vi.mocked(hasRole).mockReturnValueOnce(false);

      const response = await POST(postRequest(validBody({ org_id: 'client-org' })));

      expect(response.status).toBe(403);
      expect(hasRole).toHaveBeenCalledWith(adminSession, 'client-org', 'admin');
      expectNothingCreated();
    });

    it.each([
      'fluent-io; rm -rf /',
      '$(id)',
      'fluent-io\nrm -rf /',
      "fluent-io' OR '1'='1",
      'fluent-io`id`',
    ])('never creates anything for the shell-injection org_id %j', async (orgId) => {
      vi.mocked(hasRole).mockImplementationOnce((session, requestedOrg) =>
        session.user.orgs.some((org: { org_id: string }) => org.org_id === requestedOrg),
      );

      const response = await POST(postRequest(validBody({ org_id: orgId })));

      expect([400, 403]).toContain(response.status);
      expectNothingCreated();
    });
  });

  describe('server URL configuration', () => {
    it('returns a generic 500 and logs detail server-side when the server URL is not configured', async () => {
      delete process.env.NEXT_PUBLIC_FLUENT_FLOW_URL;

      const response = await POST(postRequest(validBody()));
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(JSON.stringify(data)).not.toContain('NEXT_PUBLIC');
      expectNothingCreated();
      expect(loggedText()).toContain('NEXT_PUBLIC_FLUENT_FLOW_URL');
    });

    it.each([
      'https://flow.example.com/$(id)',
      'https://flow.example.com;touch /tmp/pwned',
      "https://flow.example.com'",
      'https://flow.example.com --token evil',
      'https://flow.example.com\nrm -rf /',
      'https://flow.example.com`id`',
      'https://flow.example.com&evil',
      'https://flow.example.com|cat',
      'https://flow.example.com\\evil',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
      ' https://flow.example.com',
    ])('returns a generic 500 for the unsafe server URL %j', async (serverUrl) => {
      process.env.NEXT_PUBLIC_FLUENT_FLOW_URL = serverUrl;

      const response = await POST(postRequest(validBody()));
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data).toEqual({ error: 'Service misconfigured. Contact an administrator.' });
      expectNothingCreated();
    });

    it('drops trailing slashes from the server URL in the generated command', async () => {
      process.env.NEXT_PUBLIC_FLUENT_FLOW_URL = 'https://flow.example.com///';

      const response = await POST(postRequest(validBody()));
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(commandLines(data.command)).toContain('--server https://flow.example.com');
    });
  });

  describe('input validation', () => {
    async function expectRejected(body: unknown) {
      const response = await POST(postRequest(body));
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(typeof data.error).toBe('string');
      expect(data.error.length).toBeGreaterThan(0);
      expectNothingCreated();
    }

    it.each([
      'opencode',
      'claude-agent-acp',
      'codex-acp',
      'aider',
      'toString',
      '__proto__',
      'CODEX',
      '',
      7,
      null,
      ['codex'],
      { id: 'codex' },
    ])('rejects unsupported provider %j', async (provider) => {
      await expectRejected({ ...validBody({ provider }), ...LEGACY_AGENT_TYPE });
    });

    it('rejects a body that omits provider even when the legacy agent_type is present', async () => {
      const { provider: _provider, ...withoutProvider } = validBody();

      await expectRejected({ ...withoutProvider, ...LEGACY_AGENT_TYPE });
    });

    it.each([0, 17, 100, -1, 1.5, 0.5, '4', null, true, [4], { n: 4 }, Number.NaN])(
      'rejects capacity %j',
      async (capacity) => {
        await expectRejected({ ...validBody({ capacity }), ...LEGACY_AGENT_TYPE });
      },
    );

    it('rejects a body that omits capacity', async () => {
      const { capacity: _capacity, ...withoutCapacity } = validBody();

      await expectRejected({ ...withoutCapacity, ...LEGACY_AGENT_TYPE });
    });

    it.each(['hosted', 'docker', 'LOCAL', 'self-hosted', 'toString', '__proto__', '', null, 1, ['local']])(
      'rejects deployment %j',
      async (deployment) => {
        await expectRejected({ ...validBody({ deployment }), ...LEGACY_AGENT_TYPE });
      },
    );

    it('rejects a body that omits deployment', async () => {
      const { deployment: _deployment, ...withoutDeployment } = validBody();

      await expectRejected({ ...withoutDeployment, ...LEGACY_AGENT_TYPE });
    });

    it.each([
      '',
      '-leading-dash',
      '_leading-underscore',
      'has space',
      'semi;colon',
      '$(id)',
      'back`tick`',
      'new\nline',
      'trailing-newline\n',
      'dq"uote',
      "sq'uote",
      'amp&&amp',
      'pipe|pipe',
      'slash/../escape',
      'dollar$HOME',
      5,
      null,
    ])('rejects agent_id %j', async (agentId) => {
      await expectRejected({ ...validBody({ agent_id: agentId }), ...LEGACY_AGENT_TYPE });
    });

    it.each(['', 5, null, ['fluent-io']])('rejects org_id %j', async (orgId) => {
      await expectRejected({ ...validBody({ org_id: orgId }), ...LEGACY_AGENT_TYPE });
    });

    it.each(['{', '', 'null', '[]', '"codex"', '42'])('rejects the non-object body %j', async (rawBody) => {
      const response = await POST(rawRequest(rawBody));

      expect(response.status).toBe(400);
      expectNothingCreated();
    });

    it('does not echo rejected input back to the client', async () => {
      const response = await POST(postRequest({
        ...validBody({ agent_id: 'a;touch /tmp/pwned', provider: 'evil-provider-zz', deployment: 'evil-deploy-zz' }),
        ...LEGACY_AGENT_TYPE,
      }));
      const text = JSON.stringify(await response.json());

      expect(response.status).toBe(400);
      expect(text).not.toContain('touch /tmp/pwned');
      expect(text).not.toContain('evil-provider-zz');
      expect(text).not.toContain('evil-deploy-zz');
    });
  });

  describe('enrollment creation', () => {
    it.each([
      ['claude-code', 1, 'local'],
      ['codex', 4, 'local'],
      ['claude-code', 8, 'self_hosted'],
      ['codex', 16, 'self_hosted'],
    ])('creates the %s agent with capacity %i for %s deployment through one atomic call', async (provider, capacity, deployment) => {
      const response = await POST(postRequest(validBody({ agent_id: 'edge-box', provider, capacity, deployment })));
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(mockCreateAgentWithEnrollment).toHaveBeenCalledTimes(1);
      expect(mockCreateAgentWithEnrollment).toHaveBeenCalledWith(
        {
          id: 'edge-box',
          orgId: 'fluent-io',
          agentType: provider,
          transport: 'long_poll',
          transportMeta: { capacity, deployment, provider },
        },
        new Date(NOW.getTime() + FIFTEEN_MINUTES_MS),
      );
      expect(data.agent).toEqual(expect.objectContaining({
        id: 'edge-box',
        org_id: 'fluent-io',
        agent_type: provider,
        transport: 'long_poll',
        transport_meta: { capacity, deployment, provider },
      }));
      expect(mockCreateAgent).not.toHaveBeenCalled();
      expect(mockCreateToken).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('ignores the removed agent_type field when provider is supplied', async () => {
      const response = await POST(postRequest({ ...validBody({ provider: 'codex' }), agent_type: 'claude-code' }));
      expect(response.status).toBe(201);
      expect(mockCreateAgentWithEnrollment.mock.calls[0][0]).toEqual(expect.objectContaining({
        agentType: 'codex',
        transportMeta: expect.objectContaining({ provider: 'codex' }),
      }));
    });
    it('issues a 15-minute enrollment and reports its expiry', async () => {
      const response = await POST(postRequest(validBody()));
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(mockCreateAgentWithEnrollment.mock.calls[0][1]).toEqual(new Date(NOW.getTime() + FIFTEEN_MINUTES_MS));
      expect(Date.parse(data.enrollment_expires_at) - NOW.getTime()).toBe(FIFTEEN_MINUTES_MS);
    });

    it('responds with exactly agent, command and enrollment_expires_at', async () => {
      const response = await POST(postRequest(validBody()));
      const data = await response.json();
      expect(response.status).toBe(201);
      expect(Object.keys(data).sort()).toEqual(['agent', 'command', 'enrollment_expires_at']);
    });

    it('renders the local npm command with the enrollment token', async () => {
      const response = await POST(postRequest(validBody({ provider: 'codex', capacity: 4, deployment: 'local' })));
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(commandLines(data.command)).toEqual([
        'npx @fluent-flow/agent-server@latest',
        '--server https://flow.example.com',
        '--provider codex',
        '--capacity 4',
        `--enrollment-token ${ENROLLMENT_TOKEN}`,
      ]);
    });

    it('renders the self-hosted docker command with the published image and a read-only provider secret file', async () => {
      const response = await POST(postRequest(validBody({
        provider: 'claude-code',
        capacity: 8,
        deployment: 'self_hosted',
      })));
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(commandLines(data.command)).toEqual([
        'docker run -d --name fluent-flow-agent-server --restart unless-stopped --init',
        '-v /etc/fluent-flow/provider-auth:/run/secrets/provider-auth:ro',
        '-v fluent-flow-state:/home/node/.fluent-flow',
        '-v fluent-flow-work:/work',
        SELF_HOSTED_IMAGE,
        '--server https://flow.example.com',
        '--provider claude-code',
        '--capacity 8',
        '--deployment self_hosted',
        `--enrollment-token ${ENROLLMENT_TOKEN}`,
        '--provider-secret-file /run/secrets/provider-auth',
      ]);
    });

    it.each(['local', 'self_hosted'])('never renders a durable runtime token flag for %s deployment', async (deployment) => {
      const response = await POST(postRequest(validBody({ deployment })));
      const data = await response.json();
      expect(response.status).toBe(201);
      expect(data.command).not.toMatch(/--token\b/);
      expect(data.command).not.toMatch(/\bff_[0-9a-f]{8,}/);
      expect(data.command).toContain(`--enrollment-token ${ENROLLMENT_TOKEN}`);
    });

    it('does not mix the local and self-hosted command shapes', async () => {
      const local = await (await POST(postRequest(validBody({ deployment: 'local' })))).json();
      const selfHosted = await (await POST(postRequest(validBody({ deployment: 'self_hosted' })))).json();
      expect(local.command).not.toMatch(/docker|provider-secret-file|\/run\/secrets|--deployment/);
      expect(selfHosted.command).not.toContain('npx');
    });

    it.each(['local', 'self_hosted'])('keeps the plaintext enrollment token inside command only for %s deployment', async (deployment) => {
      const response = await POST(postRequest(validBody({ deployment })));
      const data = await response.json();
      const { command, ...rest } = data;

      expect(response.status).toBe(201);
      expect(command).toContain(ENROLLMENT_TOKEN);
      expect(JSON.stringify(rest)).not.toContain(ENROLLMENT_TOKEN);
      expect(JSON.stringify(data).split(ENROLLMENT_TOKEN)).toHaveLength(2);
      expect(loggedText()).not.toContain(ENROLLMENT_TOKEN);
    });

    it.each(['local', 'self_hosted'])('renders no provider credential or secret-store detail for %s deployment', async (deployment) => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-dashboard-secret');
      vi.stubEnv('OPENAI_API_KEY', 'sk-openai-dashboard-secret');
      vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-dashboard-secret');

      const response = await POST(postRequest(validBody({ deployment })));
      const text = JSON.stringify(await response.json());

      expect(response.status).toBe(201);
      expect(text).not.toContain('dashboard-secret');
      expect(text).not.toMatch(/API_KEY|OAUTH|ANTHROPIC|OPENAI|\bsk-/i);
      expect(text).not.toMatch(/\s(-e|--env|--env-file)\s/);
    });

    it.each(['local', 'self_hosted'])('renders only shell-safe characters in the %s command', async (deployment) => {
      const response = await POST(postRequest(validBody({ deployment })));
      const data = await response.json();

      expect(response.status).toBe(201);
      for (const line of data.command.split('\n')) {
        expect(line).toMatch(/^[A-Za-z0-9 @:/._=,+-]+( \\)?$/);
      }
    });

    it('returns 409 for a duplicate agent without exposing a command or token', async () => {
      mockCreateAgentWithEnrollment.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));

      const response = await POST(postRequest(validBody()));
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.command).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain(ENROLLMENT_TOKEN);
      expect(JSON.stringify(data)).not.toContain('duplicate key');
      expect(mockCreateAgent).not.toHaveBeenCalled();
      expect(mockCreateToken).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('propagates an atomic creation failure loudly without a compensating delete', async () => {
      mockCreateAgentWithEnrollment.mockRejectedValueOnce(new Error('enrollment insert failed'));

      await expect(POST(postRequest(validBody()))).rejects.toThrow('enrollment insert failed');

      expect(mockCreateAgent).not.toHaveBeenCalled();
      expect(mockCreateToken).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('propagates a failure whose code is not a unique violation instead of reporting a conflict', async () => {
      mockCreateAgentWithEnrollment.mockRejectedValueOnce(Object.assign(new Error('serialization failure'), { code: '40001' }));

      await expect(POST(postRequest(validBody()))).rejects.toThrow('serialization failure');
    });
  });
});
