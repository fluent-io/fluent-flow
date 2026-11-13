import { z } from 'zod';

const items = z.array(z.string().min(1).max(1000)).max(30);
const digestSchema = z.object({
  goal: z.string().min(1).max(3000),
  decisions: items,
  acceptanceCriteria: items.min(1),
  openQuestions: items,
  filesTouched: z.array(z.string().min(1).max(1000).refine(value =>
    !value.startsWith('/') && !value.startsWith('\\') && !/^[A-Za-z]:/u.test(value)
    && !value.includes('\0') && !value.split(/[\\/]/u).includes('..'))).max(30),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16000);

export async function prepareChatHandoff({ runtime, workspace, bridge, onAccepted }) {
  await workspace.handoff();
  bridge.resetAgentMessageText();
  const outcome = await runtime.prompt([
    'Prepare a build handoff from this conversation. Do not run tools, edit files, commit, or push.',
    'Return only one JSON object with these fields:',
    'goal: string; decisions: string[]; acceptanceCriteria: string[]; openQuestions: string[]; filesTouched: string[].',
    'Describe only agreed requirements. List unresolved questions honestly. Use repository-relative file names.',
    'Do not include secrets, credentials, private machine paths, or internal service configuration.',
    'Keep the JSON under 16000 UTF-8 bytes, each array under 30 items, and each item under 1000 characters.',
  ].join('\n'), { onAccepted });
  await bridge.finalizeEvents();
  if (outcome.stopReason !== 'end_turn') {
    throw Object.assign(new Error('Handoff summary was interrupted'), { handoffCode: 'summary_interrupted' });
  }
  const text = bridge.agentMessageText().trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, '$1');
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw Object.assign(new Error('Handoff summary is not valid JSON'), { handoffCode: 'summary_invalid' });
  }
  const digest = digestSchema.safeParse(decoded);
  if (!digest.success) throw Object.assign(new Error('Handoff summary is incomplete or too large'), { handoffCode: 'summary_invalid' });
  return { ...await workspace.handoff(), digest: digest.data };
}
