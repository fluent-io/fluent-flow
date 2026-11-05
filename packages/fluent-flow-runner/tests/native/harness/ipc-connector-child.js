import { connectSupervisor } from '../../../src/supervisor/client.js';

const { instanceId, stateDir, submit, deliver, ackFirst } = JSON.parse(process.env.FF_TEST_CONNECTOR ?? 'null') ?? {};
const say = (line) => process.stdout.write(`${line}\n`);

const client = await connectSupervisor({ instanceId, stateDir, role: 'connector' });
say(`submitted ${JSON.stringify(await client.request('submit', submit))}`);
say(`delivered ${JSON.stringify(await client.request('deliver', deliver))}`);
if (ackFirst) {
  for (;;) {
    const { events } = await client.request('events', { afterSeq: 0, limit: 500 });
    if (events.length) {
      const { deliveredSeq } = await client.request('ackEvents', { uptoSeq: events[0].seq });
      say(`acked ${deliveredSeq}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
say('waiting');
await new Promise(() => {});
