import { describe, expect, it, vi } from "vitest";
import { type SyncReason, SyncScheduler } from "../src/scheduler.ts";

/** A controllable clock, so nothing here waits in real time. */
class FakeTimers {
  private next = 1;
  private readonly timers = new Map<number, { fn: () => void; at: number }>();
  now = 0;

  set = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.set(id, { fn, at: this.now + ms });
    return id;
  };

  clear = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.timers]) {
      if (t.at <= this.now) {
        this.timers.delete(id);
        t.fn();
      }
    }
  }

  get pending(): number {
    return this.timers.size;
  }
}

function make(opts: { debounceMs?: number; intervalMs?: number } = {}) {
  const timers = new FakeTimers();
  const calls: SyncReason[] = [];
  let release: (() => void) | null = null;

  const run = vi.fn(async (reason: SyncReason) => {
    calls.push(reason);
    if (release) await new Promise<void>((r) => (release = r as never));
  });

  const scheduler = new SyncScheduler(
    { run, setTimer: timers.set, clearTimer: timers.clear },
    { debounceMs: opts.debounceMs ?? 5000, intervalMs: opts.intervalMs ?? 0 },
  );
  return { scheduler, timers, calls, run, hold: () => (release = () => {}) };
}

describe("single flight", () => {
  it("coalesces a burst of requests into one follow-up run", async () => {
    let resolveRun: (() => void) | undefined;
    const calls: SyncReason[] = [];
    const scheduler = new SyncScheduler(
      {
        run: async (reason) => {
          calls.push(reason);
          await new Promise<void>((r) => (resolveRun = r));
        },
      },
      { debounceMs: 0, intervalMs: 0 },
    );

    scheduler.request("manual");
    await Promise.resolve();
    expect(calls).toEqual(["manual"]);
    expect(scheduler.isRunning).toBe(true);

    // Ten more requests arrive mid-flight.
    for (let i = 0; i < 10; i++) scheduler.request("file-change");

    resolveRun!();
    await new Promise((r) => setTimeout(r, 0));

    // Exactly one follow-up, not ten.
    expect(calls).toEqual(["manual", "file-change"]);
  });

  it("lets a manual request outrank a queued automatic one", async () => {
    let resolveRun: (() => void) | undefined;
    const calls: SyncReason[] = [];
    const scheduler = new SyncScheduler(
      {
        run: async (reason) => {
          calls.push(reason);
          await new Promise<void>((r) => (resolveRun = r));
        },
      },
      { debounceMs: 0, intervalMs: 0 },
    );

    scheduler.request("startup");
    await Promise.resolve();
    scheduler.request("interval");
    scheduler.request("manual");

    resolveRun!();
    await new Promise((r) => setTimeout(r, 0));

    expect(calls[1]).toBe("manual");
  });

  it("keeps running after a failure", async () => {
    const calls: SyncReason[] = [];
    const errors: unknown[] = [];
    const scheduler = new SyncScheduler(
      {
        run: async (reason) => {
          calls.push(reason);
          throw new Error("network down");
        },
        onError: (e) => errors.push(e),
      },
      { debounceMs: 0, intervalMs: 0 },
    );

    scheduler.request("manual");
    await new Promise((r) => setTimeout(r, 0));
    scheduler.request("manual");
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toHaveLength(2);
    expect(errors).toHaveLength(2);
    expect(scheduler.isRunning).toBe(false);
  });
});

describe("debounce", () => {
  it("syncs once after a burst of edits settles", () => {
    const { scheduler, timers, calls } = make({ debounceMs: 5000 });

    for (let i = 0; i < 20; i++) {
      scheduler.requestDebounced("file-change");
      timers.advance(100);
    }
    expect(calls).toHaveLength(0);

    timers.advance(5000);
    expect(calls).toEqual(["file-change"]);
  });

  it("a manual request cancels a pending debounce rather than queueing behind it", () => {
    const { scheduler, timers, calls } = make({ debounceMs: 5000 });

    scheduler.requestDebounced("file-change");
    scheduler.request("manual");
    expect(calls).toEqual(["manual"]);

    timers.advance(10_000);
    expect(calls).toEqual(["manual"]);
  });
});

/** Lets queued promise callbacks run, as they would between real timer ticks. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("interval", () => {
  it("fires repeatedly and reschedules itself", async () => {
    const { scheduler, timers, calls } = make({ intervalMs: 60_000 });
    scheduler.startInterval();

    for (let i = 0; i < 3; i++) {
      timers.advance(60_000);
      await flush();
    }

    expect(calls).toEqual(["interval", "interval", "interval"]);
  });

  it("coalesces ticks that arrive while a sync is still running", async () => {
    // A slow sync must not queue up a backlog of interval runs behind it: the
    // point of the interval is to be current, not to run N times.
    const { scheduler, timers, calls } = make({ intervalMs: 60_000 });
    scheduler.startInterval();

    timers.advance(60_000);
    timers.advance(60_000);
    timers.advance(60_000);
    await flush();
    await flush();

    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("stops cleanly", () => {
    const { scheduler, timers, calls } = make({ intervalMs: 60_000 });
    scheduler.startInterval();
    timers.advance(60_000);
    scheduler.stopInterval();
    timers.advance(300_000);

    expect(calls).toHaveLength(1);
    expect(timers.pending).toBe(0);
  });

  it("is disabled when the interval is zero", () => {
    const { scheduler, timers } = make({ intervalMs: 0 });
    scheduler.startInterval();
    timers.advance(3_600_000);
    expect(timers.pending).toBe(0);
  });
});

describe("reconfiguration", () => {
  it("can re-enable a periodic sync that was turned off", async () => {
    // Keying the restart off a live timer handle would make "set to 0" a
    // one-way door until Obsidian restarts.
    const { scheduler, timers, calls } = make({ intervalMs: 60_000 });
    scheduler.startInterval();

    scheduler.updateConfig({ debounceMs: 5000, intervalMs: 0 });
    timers.advance(600_000);
    expect(calls).toHaveLength(0);

    scheduler.updateConfig({ debounceMs: 5000, intervalMs: 60_000 });
    timers.advance(60_000);
    await flush();

    expect(calls).toEqual(["interval"]);
  });

  it("starts a periodic sync that was never running", async () => {
    const { scheduler, timers, calls } = make({ intervalMs: 0 });
    scheduler.startInterval();

    scheduler.updateConfig({ debounceMs: 5000, intervalMs: 60_000 });
    timers.advance(60_000);
    await flush();

    expect(calls).toEqual(["interval"]);
  });

  it("picks up a changed period", async () => {
    const { scheduler, timers, calls } = make({ intervalMs: 60_000 });
    scheduler.startInterval();

    scheduler.updateConfig({ debounceMs: 5000, intervalMs: 10_000 });
    timers.advance(10_000);
    await flush();

    expect(calls).toEqual(["interval"]);
  });
});

describe("shutdown", () => {
  it("cancels every timer and ignores later requests", () => {
    const { scheduler, timers, calls } = make({ debounceMs: 5000, intervalMs: 60_000 });
    scheduler.startInterval();
    scheduler.requestDebounced("file-change");

    scheduler.stop();
    timers.advance(600_000);
    scheduler.request("manual");

    expect(calls).toHaveLength(0);
    expect(timers.pending).toBe(0);
  });
});
