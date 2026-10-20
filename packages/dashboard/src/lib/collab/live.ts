/** A late response from an old project/session must never restore revoked data. */
export class LatestRequest {
  private controller: AbortController | null = null;
  private signal: AbortSignal | null = null;

  begin(parent?: AbortSignal): AbortSignal {
    this.dispose();
    this.controller = new AbortController();
    this.signal = parent ? AbortSignal.any([parent, this.controller.signal]) : this.controller.signal;
    return this.signal;
  }

  current(signal: AbortSignal): boolean {
    return this.signal === signal && !signal.aborted;
  }

  dispose(): void {
    this.controller?.abort();
    this.controller = null;
    this.signal = null;
  }
}

/** The refresh callback owns its error UI; slow requests never overlap. */
export function pollResource(refresh: (signal: AbortSignal) => Promise<void>, intervalMs = 3000): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (!controller.signal.aborted) timer = setTimeout(tick, intervalMs);
  };
  const tick = () => { void refresh(controller.signal).then(schedule); };
  tick();
  return () => { controller.abort(); clearTimeout(timer); };
}
