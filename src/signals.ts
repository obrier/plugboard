const MAX_TIMER_MS = 2 ** 31 - 1; // about 24.8 days, the longest delay setTimeout holds

/** A call's signal: aborted when any of its sources aborts, or when its time runs out, with the same reasons as
 * AbortSignal.any and AbortSignal.timeout. Unlike those, it lets go when the call is done: `dispose()` removes its
 * listeners from the sources and clears its timer. AbortSignal.any keeps each combined signal for as long as its sources
 * live (a batch's own signals, a program's signal passed to every call), and AbortSignal.timeout keeps each call until
 * its timer fires, so a long batch or a long-lived program grows with every call. */
export function linkSignals(sources: readonly (AbortSignal | undefined)[], timeoutMs?: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const off: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    for (const remove of off.splice(0)) remove();
  };
  const abort = (reason: unknown) => { dispose(); controller.abort(reason); };
  for (const source of sources) {
    if (!source) continue;
    if (source.aborted) { abort(source.reason); return { signal: controller.signal, dispose }; }
    const onAbort = () => abort(source.reason);
    source.addEventListener("abort", onAbort, { once: true });
    off.push(() => source.removeEventListener("abort", onAbort));
  }
  if (timeoutMs !== undefined && timeoutMs <= MAX_TIMER_MS) { // a longer one is no limit: setTimeout would fire it at once
    timer = setTimeout(() => abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), timeoutMs);
    (timer as { unref?: () => void }).unref?.(); // like AbortSignal.timeout: never what keeps a program running
  }
  return { signal: controller.signal, dispose };
}
