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
 * Resolve the command to execute for a work item.
 *
 * For built-in agent types: returns { bin, args } with prompt as a discrete arg (no shell).
 * For custom commands (CLI --command or transport_meta.command): returns { shell: command-string }
 *   where the prompt replaces {prompt} with shell metacharacters escaped.
 *
 * Priority: commandOverride (CLI --command) > transportCommand (transport_meta.command) > AGENT_COMMANDS[agentType]
 *
 * @param {object} opts
 * @param {string} opts.agentType — e.g. "claude-code", "codex", "aider", "custom"
 * @param {string} opts.prompt — the review feedback message
 * @param {string} [opts.commandOverride] — CLI --command flag (template string)
 * @param {string} [opts.transportCommand] — transport_meta.command from server (template string)
 * @returns {{ bin: string, args: string[] } | { shell: string }}
 */
export function resolveCommand({ agentType, prompt, commandOverride, transportCommand }) {
  const customTemplate = commandOverride ?? transportCommand;

  if (customTemplate) {
    // Custom template — must use shell. Escape shell metacharacters in prompt.
    return { shell: customTemplate.replace(/\{prompt\}/g, escapeForShell(prompt)) };
  }

  const builder = AGENT_COMMANDS[agentType];
  if (!builder) {
    throw new Error(`No command template for agent type "${agentType}"`);
  }

  return builder(prompt);
}

/**
 * Escape a string for safe embedding in a double-quoted shell argument.
 * Handles: double quotes, backticks, dollar signs, backslashes, newlines.
 * @param {string} str
 * @returns {string}
 */
export function escapeForShell(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/\n/g, '\\n');
}
