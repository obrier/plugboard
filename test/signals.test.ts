// linkSignals: a call's signal that lets go of its sources and its timer once the call is done.
import { describe, expect, test } from "bun:test";
import { linkSignals } from "../src/signals";

/** A source that counts the abort listeners it holds. */
function source() {
  const c = new AbortController();
  let held = 0;
  const add = c.signal.addEventListener.bind(c.signal), remove = c.signal.removeEventListener.bind(c.signal);
  c.signal.addEventListener = ((type: string, fn: any, o?: any) => { if (type === "abort") held++; add(type, fn, o); }) as typeof add;
  c.signal.removeEventListener = ((type: string, fn: any, o?: any) => { if (type === "abort") held--; remove(type, fn, o); }) as typeof remove;
  return { controller: c, signal: c.signal, held: () => held };
}

describe("linkSignals", () => {
  test("aborts when any source aborts, with that source's reason", () => {
    const a = source(), b = source();
    const link = linkSignals([a.signal, undefined, b.signal]);
    b.controller.abort(new Error("b went"));
    expect(link.signal.aborted).toBe(true);
    expect((link.signal.reason as Error).message).toBe("b went");
  });

  test("a source already aborted aborts it at once, and nothing is left listening", () => {
    const a = source(), b = source();
    b.controller.abort("early");
    const link = linkSignals([a.signal, b.signal]);
    expect(link.signal.aborted).toBe(true);
    expect(link.signal.reason).toBe("early");
    expect([a.held(), b.held()]).toEqual([0, 0]);
  });

  test("its time running out aborts it with a TimeoutError, as AbortSignal.timeout does", async () => {
    const link = linkSignals([], 5);
    await new Promise(r => setTimeout(r, 30));
    expect(link.signal.aborted).toBe(true);
    expect((link.signal.reason as DOMException).name).toBe("TimeoutError");
  });

  test("a timeout longer than a timer can hold (about 24.8 days) waits, never fires at once", async () => {
    for (const ms of [2 ** 31, 3e9, Infinity]) {
      const link = linkSignals([], ms);
      await new Promise(r => setTimeout(r, 20));
      expect(link.signal.aborted).toBe(false);
      link.dispose();
    }
  });

  test("dispose lets go of every source and the timer: nothing aborts it afterwards", async () => {
    const a = source(), b = source();
    const link = linkSignals([a.signal, b.signal], 5);
    expect([a.held(), b.held()]).toEqual([1, 1]);
    link.dispose();
    expect([a.held(), b.held()]).toEqual([0, 0]);
    a.controller.abort();
    await new Promise(r => setTimeout(r, 30));
    expect(link.signal.aborted).toBe(false);
  });

  test("once one source aborts it, it stops listening to the others", () => {
    const a = source(), b = source();
    linkSignals([a.signal, b.signal]);
    a.controller.abort();
    expect(b.held()).toBe(0);
  });
});
