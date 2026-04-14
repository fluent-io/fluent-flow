import { createSign } from 'crypto';

/**
 * Sign a GitHub App JWT using RS256.
 *
 * @param {{ appId: string, privateKeyPem: string }} opts
 * @returns {string} Signed JWT token
 */
export function signAppJwt({ appId, privateKeyPem }) {
  const now = Math.floor(Date.now() / 1000);
  const iat = now - 60;       // 60s in the past to account for clock drift
  const exp = now + 9 * 60;   // 9 minutes from now (GitHub allows up to 10)

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat, exp, iss: appId })).toString('base64url');

  const signingInput = `${header}.${payload}`;

  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  sign.end();
  const signature = sign.sign(privateKeyPem, 'base64url');

  return `${signingInput}.${signature}`;
}

/**
 * Exchange an App JWT for an installation access token.
 *
 * @param {{ appId: string, privateKeyPem: string, installationId: number }} opts
 * @returns {Promise<{ token: string, expiresAt: Date }>}
 */
export async function fetchInstallationToken({ appId, privateKeyPem, installationId }) {
  const jwt = signAppJwt({ appId, privateKeyPem });

  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`GitHub App token exchange failed: ${response.status} — ${body}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  return {
    token: data.token,
    expiresAt: new Date(data.expires_at),
  };
}
