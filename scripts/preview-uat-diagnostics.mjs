import { readFileSync, writeFileSync } from 'node:fs';

const [sourcePath, destinationPath] = process.argv.slice(2);
if (!sourcePath || !destinationPath) throw new Error('Source and destination paths are required');

function sanitize(line) {
  return line
    .replace(/https?:\/\/[^\s"']+/gu, (value) => {
      if (!URL.canParse(value)) return '[REDACTED_URL]';
      const url = new URL(value);
      url.search = '';
      url.hash = '';
      return url.toString();
    })
    .replace(/((?:secret|token|password|authorization|cookie|code|state)["'\s:=]+)[^,\s}"']+/giu, '$1[REDACTED]')
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]+|ff_[A-Za-z0-9_-]+|[A-Fa-f0-9]{64})\b/gu, '[REDACTED]');
}

const lines = readFileSync(sourcePath, 'utf8').split(/\r?\n/u);
const selected = new Set();
for (let index = 0; index < lines.length; index += 1) {
  if (!/(?:next-auth|oauth|callback|error)/iu.test(lines[index])) continue;
  for (let offset = -1; offset <= 1; offset += 1) {
    const selectedIndex = index + offset;
    if (selectedIndex >= 0 && selectedIndex < lines.length) selected.add(selectedIndex);
  }
}
const diagnostics = [...selected].sort((left, right) => left - right).map((index) => sanitize(lines[index]));
writeFileSync(destinationPath, `${JSON.stringify({ diagnostics }, null, 2)}\n`, { mode: 0o600 });
