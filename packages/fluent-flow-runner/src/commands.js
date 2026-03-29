/**
 * Agent command templates by agent_type.
 * {prompt} is replaced with the escaped review feedback.
 */
export const AGENT_COMMANDS = {
  'claude-code': 'claude -p "{prompt}" --allowedTools "Read,Edit,Bash,Write,Glob,Grep" --output-format json',
  'codex': 'codex --quiet --approval-mode full-auto -p "{prompt}"',
  'aider': 'aider --yes --message "{prompt}"',
};

/**
 * Escape double quotes in a string for safe shell embedding.
 * @param {string} str
 * @returns {string}
 */
function escapeQuotes(str) {
  return str.replace(/"/g, '\\"');
}

/**
 * Resolve the shell command to execute for a work item.
 *
 * Priority: commandOverride (CLI --command) > transportCommand (transport_meta.command) > AGENT_COMMANDS[agentType]
 *
 * @param {object} opts
 * @param {string} opts.agentType — e.g. "claude-code", "codex", "aider", "custom"
 * @param {string} opts.prompt — the review feedback message
 * @param {string} [opts.commandOverride] — CLI --command flag
 * @param {string} [opts.transportCommand] — transport_meta.command from server
 * @returns {string} — resolved shell command
 */
export function resolveCommand({ agentType, prompt, commandOverride, transportCommand }) {
  const template = commandOverride ?? transportCommand ?? AGENT_COMMANDS[agentType];
  if (!template) {
    throw new Error(`No command template for agent type "${agentType}"`);
  }
  return template.replace(/\{prompt\}/g, escapeQuotes(prompt));
}
