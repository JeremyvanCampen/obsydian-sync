/**
 * Decides *when* to sync.
 *
 * Two properties matter here and both are easy to get wrong:
 *
 *  - **Single flight.** Only one sync runs at a time. Overlapping runs are the
 *    classic source of duplicate uploads and of a scan racing its own writes.
 *    Requests arriving during a run coalesce into exactly one follow-up, so a
 *    burst of file changes produces two syncs, not twenty.
 *  - **Trailing debounce.** Typing a note fires a `modify` event per keystroke.
 *    Syncing on each one would be useless work and constant network.
 *
 * Timers are injected so the behaviour is testable without waiting in real time.
 */

export type SyncReason = "manual" | "startup" | "file-change" | "interval" | "focus";

export interface SchedulerHooks {
  run(reason: SyncReason): Promise<void>;
  onError?(error: unknown, reason: SyncReason): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface SchedulerConfig {
  /** Quiet period after the last change before syncing. */
  debounceMs: number;
  /** Periodic sync while the app is in the foreground. 0 disables. */
  intervalMs: number;
}

export class SyncScheduler {
  private running = false;
  /** A request that arrived while a sync was in flight. */
  private pending: SyncReason | null = null;
  private debounceHandle: unknown = null;
  private intervalHandle: unknown = null;
  /** Whether periodic sync is meant to be running, independent of any handle. */
  private intervalEnabled = false;
  private stopped = false;

  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly hooks: SchedulerHooks,
    private config: SchedulerConfig,
  ) {
    this.setTimer = hooks.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = hooks.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Sync as soon as possible, coalescing with anything already in flight. */
  request(reason: SyncReason): void {
    if (this.stopped) return;
    this.cancelDebounce();
    void this.execute(reason);
  }

  /** Sync once the vault has been quiet for `debounceMs`. */
  requestDebounced(reason: SyncReason): void {
    if (this.stopped) return;
    this.cancelDebounce();
    this.debounceHandle = this.setTimer(() => {
      this.debounceHandle = null;
      void this.execute(reason);
    }, this.config.debounceMs);
  }

  startInterval(): void {
    this.stopInterval();
    if (this.stopped || this.config.intervalMs <= 0) return;
    this.intervalEnabled = true;
    const tick = () => {
      this.intervalHandle = this.setTimer(tick, this.config.intervalMs);
      void this.execute("interval");
    };
    this.intervalHandle = this.setTimer(tick, this.config.intervalMs);
  }

  stopInterval(): void {
    this.intervalEnabled = false;
    if (this.intervalHandle !== null) {
      this.clearTimer(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  updateConfig(config: SchedulerConfig): void {
    const wasEnabled = this.intervalEnabled;
    this.config = config;
    // Restart whenever periodic sync is on *or was* on. Keying off
    // `intervalHandle` instead would make setting the interval to 0 and back
    // again permanent: there would be no handle left to notice.
    if (wasEnabled || config.intervalMs > 0) this.startInterval();
  }

  /** Cancels everything pending. Called from the plugin's onunload. */
  stop(): void {
    this.stopped = true;
    this.cancelDebounce();
    this.stopInterval();
    this.pending = null;
  }

  private cancelDebounce(): void {
    if (this.debounceHandle !== null) {
      this.clearTimer(this.debounceHandle);
      this.debounceHandle = null;
    }
  }

  private async execute(reason: SyncReason): Promise<void> {
    if (this.running) {
      // Coalesce. A manual request outranks an automatic one, so the reason
      // reported to the user is the one they will recognise.
      if (this.pending === null || reason === "manual") this.pending = reason;
      return;
    }

    this.running = true;
    try {
      await this.hooks.run(reason);
    } catch (e) {
      // A failed sync must never stop the scheduler: the next trigger should
      // try again, and a phone that was offline for an hour should recover on
      // its own.
      this.hooks.onError?.(e, reason);
    } finally {
      this.running = false;
    }

    const next = this.pending;
    this.pending = null;
    if (next !== null && !this.stopped) await this.execute(next);
  }
}
