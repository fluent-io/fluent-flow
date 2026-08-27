import { relative, sep } from 'node:path';

function toMessage(details) {
  const error = details?.error;
  if (!error) return '';
  return String(error.cause?.message ?? error.message ?? error.cause ?? '');
}

function normalizeFile(file) {
  if (!file) return '';
  return relative(process.cwd(), file).split(sep).join('/');
}

export default async function* reporter(source) {
  const rows = [];
  for await (const event of source) {
    if (!['test:complete', 'test:pass', 'test:fail'].includes(event.type)) continue;
    const data = event.data ?? {};
    const details = data.details ?? {};
    const row = {
      file: normalizeFile(data.file ?? data.name),
      name: data.name ?? '',
      status: 'pass',
      message: '',
    };
    if (details.skip || details.todo || data.skip || data.todo) {
      row.status = 'skip';
    } else if (details.error || event.type === 'test:fail' || details.passed === false) {
      row.status = details.type === 'suite' ? 'suite-error' : 'assertion-fail';
      row.message = toMessage(details);
    }
    rows.push(row);
  }
  yield JSON.stringify(rows);
}
