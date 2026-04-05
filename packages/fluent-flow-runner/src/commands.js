/**
 * Agent command definitions by agent_type.
 * Each entry returns { bin, args } where the prompt is passed as a discrete
 * argument — never interpolated into a shell string.
 */
export const AGENT_COMMANDS = {
  'claude-code': (prompt) => ({
    bin: 'claude',
    args: ['-p', prompt, '--allowedTools', 'Read,Edit,Bash,Write,Glob,Grep', '--output-format', 'json'],
  }),
  'codex': (prompt) => ({
    bin: 'codex',
    args: ['--quiet', '--approval-mode', 'full-auto', '-p', prompt],
  }),
  'aider': (prompt) => ({
    bin: 'aider',
    args: ['--yes', '--message', prompt],
  }),
};

/**
 * Maximum prompt length (128 KB) to avoid oversized command strings.
 */
export const MAX_PROMPT_LENGTH = 128 * 1024;

/**
 * Resolve the command to execute for a work item.
 *
 * For built-in agent types: returns { bin, args } with prompt as a discrete arg (no shell).
 * For custom commands (CLI --command or transport_meta.command): returns { shell, env }
 *   where the prompt is passed via FLUENT_FLOW_PROMPT env var to avoid shell injection.
 *   The template's {prompt} placeholder is replaced with a shell reference to the env var.
 *
 * Priority: commandOverride (CLI --command) > transportCommand (transport_meta.command) > AGENT_COMMANDS[agentType]
 *
 * @param {object} opts
 * @param {string} opts.agentType — e.g. "claude-code", "codex", "aider", "custom"
 * @param {string} opts.prompt — the review feedback message
 * @param {string} [opts.commandOverride] — CLI --command flag (template string)
 * @param {string} [opts.transportCommand] — transport_meta.command from server (template string)
 * @returns {{ bin: string, args: string[] } | { shell: string, env: Record<string, string> }}
 */
export function resolveCommand({ agentType, prompt, commandOverride, transportCommand }) {
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} bytes`);
  }

  const customTemplate = commandOverride ?? transportCommand;

  if (customTemplate) {
    // Pass prompt via env var to avoid shell injection entirely.
    // Replace {prompt} with a shell variable reference.
    const shell = customTemplate.replace(
      /\{prompt\}/g,
      process.platform === 'win32' ? '%FLUENT_FLOW_PROMPT%' : '"$FLUENT_FLOW_PROMPT"',
    );
    return { shell, env: { FLUENT_FLOW_PROMPT: prompt } };
  }

  const builder = AGENT_COMMANDS[agentType];
  if (!builder) {
    throw new Error(`No command template for agent type "${agentType}"`);
  }

  return builder(prompt);
}
