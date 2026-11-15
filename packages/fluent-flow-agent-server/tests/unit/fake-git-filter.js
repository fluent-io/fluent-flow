import { writeFileSync } from 'node:fs';

writeFileSync(process.argv[2], JSON.stringify({
  pid: process.pid,
  parentPid: process.ppid,
  hasReportingSecrets: Object.keys(process.env).some((name) => name.startsWith('FLUENT_FLOW_REPORTING_')),
}));
setInterval(() => {}, 1000);
