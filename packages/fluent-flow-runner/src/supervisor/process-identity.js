import { readFile } from 'node:fs/promises';


export function parseStat(raw) {
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const rest = raw.slice(close + 2).trim().split(/\s+/);
  const field = (n) => rest[n - 3];
  const startTicks = Number(field(22));
  const pgid = Number(field(5));
  if (!Number.isSafeInteger(startTicks) || !Number.isSafeInteger(pgid)) return null;
  return { state: field(3), ppid: Number(field(4)), pgid, startTicks };
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ESRCH') return null;
    throw err;
  }
}

export async function readBootId({ procRoot = '/proc' } = {}) {
  const raw = await readFile(`${procRoot}/sys/kernel/random/boot_id`, 'utf8');
  return raw.trim();
}

export async function readProcessDetails(pid, { procRoot = '/proc' } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const raw = await readOptional(`${procRoot}/${pid}/stat`);
  if (raw === null) return null;
  const stat = parseStat(raw);
  if (!stat) return null;
  const cgroupRaw = await readOptional(`${procRoot}/${pid}/cgroup`);
  const cgroup = cgroupRaw?.split('\n').find((line) => line.startsWith('0::'))?.slice(3) ?? null;
  return { pid, ppid: stat.ppid, startTicks: stat.startTicks, bootId: await readBootId({ procRoot }), pgid: stat.pgid, cgroup };
}

/** @returns {Promise<{ pid: number, startTicks: number, bootId: string } | null>} */
export async function readProcessIdentity(pid, { procRoot = '/proc' } = {}) {
  const details = await readProcessDetails(pid, { procRoot });
  return details && { pid: details.pid, startTicks: details.startTicks, bootId: details.bootId };
}

export function sameProcess(a, b) {
  return Boolean(a && b) && a.pid === b.pid && a.startTicks === b.startTicks && a.bootId === b.bootId;
}

export async function isLive(identity, { procRoot = '/proc' } = {}) {
  if (!identity) return false;
  return sameProcess(identity, await readProcessIdentity(identity.pid, { procRoot }));
}
