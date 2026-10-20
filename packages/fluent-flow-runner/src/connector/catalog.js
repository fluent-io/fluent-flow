/**
 * Builds the sanitized execution catalog the connector publishes at
 * registration: allowlisted repository keys plus configured Paseo agent
 * profiles (name/provider/model/mode/thinking/features only).
 *
 * Secrets never leave the host: provider env/keys, profile notes and the rest
 * of the daemon config are read here and filtered out. The control plane only
 * ever sees the sanitized projection below.
 */

/**
 * @param {object} opts
 * @param {{repositories: Record<string,string>, profiles: string[]}} opts.config - loaded connector config
 * @param {object} opts.paseo - connected PaseoApi (client.config.get())
 * @returns {Promise<{repositories: Array<{key:string}>, profiles: Array<object>}>}
 */
export async function buildCatalog({ config, paseo }) {
  const { config: daemonConfig } = await paseo.config.get();
  const allProfiles = daemonConfig.agentProfiles ?? [];
  const byId = new Map(allProfiles.map((p) => [p.id, p]));

  const profiles = config.profiles.map((id) => {
    const profile = byId.get(id);
    if (!profile) {
      throw new Error(
        `Allowlisted Paseo profile ${id} does not exist in the local daemon config; fix the connector config profiles allowlist`,
      );
    }
    return {
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      model: profile.model ?? null,
      modeId: profile.modeId ?? null,
      thinkingOptionId: profile.thinkingOptionId ?? null,
      features: profile.featureValues ?? {},
    };
  });

  return {
    repositories: Object.keys(config.repositories).map((key) => ({ key })),
    profiles,
  };
}

/**
 * Resolve a launch mapping locally: repository key -> canonical path and
 * profile id -> sanitized profile snapshot. Anything not allowlisted is
 * rejected; client task text can never widen this.
 */
export function resolveLaunchTargets({ config, repositoryKey, profileId }) {
  const repoPath = config.repositories[repositoryKey];
  if (!repoPath) {
    throw new Error(`Repository key is not allowlisted on this host: ${repositoryKey}`);
  }
  if (!config.profiles.includes(profileId)) {
    throw new Error(`Profile is not allowlisted on this host: ${profileId}`);
  }
  return { repoPath, profileId };
}
