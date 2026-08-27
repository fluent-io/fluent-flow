import { relative, sep } from 'node:path';

function toMessage(details) {
  const error = details?.error;
  if (!error) return '';
  return String(error.cause?.message ?? error.message ?? error.cause ?? '');
}

function toPosix(path) {
  return String(path).replaceAll('\\', '/');
}

function normalizeFile(file) {
  if (!file) return '';
  return toPosix(relative(process.cwd(), file));
}

function isFileWrapper(data) {
  if (!data.file || !data.name) return false;
  const name = toPosix(data.name).replace(/^\.\//, '');
  return name === normalizeFile(data.file) || name === toPosix(data.file);
}

function isPassingAggregateWrapper(data, details) {
  if (details.error || details.passed === false) return false;
  return details.type === 'suite' || isFileWrapper(data);
}

export default async function* reporter(source) {
  const rows = [];
  for await (const event of source) {
    if (event.type !== 'test:complete') continue;
    const data = event.data ?? {};
    const details = data.details ?? {};
    if (details.error?.failureType === 'subtestsFailed' || isPassingAggregateWrapper(data, details)) continue;
    const row = {
      file: normalizeFile(data.file ?? data.name),
      name: data.name ?? '',
      status: 'pass',
      message: '',
    };
    if (details.skip || details.todo || data.skip || data.todo) {
      row.status = 'skip';
    } else if (details.error || details.passed === false) {
      row.status = details.type === 'suite' || isFileWrapper(data) ? 'suite-error' : 'assertion-fail';
      row.message = toMessage(details);
    }
    rows.push(row);
  }
  yield JSON.stringify(rows);
}
