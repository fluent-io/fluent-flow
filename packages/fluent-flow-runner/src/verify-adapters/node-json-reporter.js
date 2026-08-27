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

function isAggregateWrapper(data, details) {
  if (details.type === 'suite') return true;
  if (details.error?.failureType === 'subtestsFailed') return true;
  return data.file && data.name === data.file && !details.error;
}

export default async function* reporter(source) {
  const rows = [];
  for await (const event of source) {
    if (event.type !== 'test:complete') continue;
    const data = event.data ?? {};
    const details = data.details ?? {};
    if (isAggregateWrapper(data, details)) continue;
    const row = {
      file: normalizeFile(data.file ?? data.name),
      name: data.name ?? '',
      status: 'pass',
      message: '',
    };
    if (details.skip || details.todo || data.skip || data.todo) {
      row.status = 'skip';
    } else if (details.error || details.passed === false) {
      row.status = data.file && data.name === data.file && details.error ? 'suite-error' : 'assertion-fail';
      row.message = toMessage(details);
    }
    rows.push(row);
  }
  yield JSON.stringify(rows);
}
