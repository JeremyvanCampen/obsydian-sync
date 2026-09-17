import { Notice, Plugin, type TAbstractFile } from "obsidian";
import { SyncApi } from "./api.ts";
import { type VaultKeys, deriveKeys, deriveMasterKey, fromBase64, makeKdfCheck, verifyKdfCheck } from "./crypto.ts";
import { obsidianTransport } from "./obsidian-transport.ts";
import type { Note } from "./reconcile.ts";
import { type SyncReason, SyncScheduler } from "./scheduler.ts";
import { DEFAULT_SETTINGS, type ObsydianSyncSettings, ObsydianSyncSettingTab } from "./settings.ts";
import { PLUGIN_DIR } from "./state.ts";
import { SyncError, type SyncSummary, runSync } from "./sync.ts";

const LOG_LIMIT = 200;

/**
 * Floor for PBKDF2 iterations accepted when initializing a vault. Well below
 * the 600000 default, but far above anything that would make the passphrase
 * cheap to attack.
 */
const MIN_KDF_ITERATIONS = 100_000;

/** Minimum PBKDF2 salt. The spec's own salt is 32 bytes. */
const MIN_KDF_SALT_BYTES = 16;

interface LogLine {
  at: number;
  level: "info" | "warn" | "error";
  message: string;
}

export default class ObsydianSyncPlugin extends Plugin {
  override settings: ObsydianSyncSettings = { ...DEFAULT_SETTINGS };
  private scheduler: SyncScheduler | null = null;
  /** Set for the next scheduled run only; see the confirm-deletions command. */
  private confirmNextRun = false;
  private statusBar: HTMLElement | null = null;
  private keys: VaultKeys | null = null;
  /**
   * What the cached keys were derived from. The server contributes the KDF
   * salt, so pointing at a different vault with the same passphrase must
   * re-derive — otherwise the stale keys fail verification and the user is
   * told their correct passphrase is wrong.
   */
  private keysFor = "";
  private readonly log: LogLine[] = [];
  private lastSummary: SyncSummary | null = null;
  /** Set when a sync stopped to ask about mass deletion. */
  private awaitingConfirmation = false;

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBar = this.addStatusBarItem();
    this.setStatus("idle");

    this.scheduler = new SyncScheduler(
      {
        run: (reason) => {
          const confirm = this.confirmNextRun;
          this.confirmNextRun = false;
          return this.sync(reason, { confirmMassDeletion: confirm });
        },
        onError: (error) => this.recordError(error),
      },
      this.schedulerConfig(),
    );

    this.addSettingTab(new ObsydianSyncSettingTab(this.app, this));

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.scheduler?.request("manual"),
    });

    this.addCommand({
      id: "sync-confirm-deletions",
      name: "Sync, confirming pending deletions",
      checkCallback: (checking) => {
        if (!this.awaitingConfirmation) return false;
        if (!checking) {
          // Through the scheduler, not directly: a direct call could run
          // concurrently with an interval or focus sync already in flight,
          // which is the overlapping-run hazard single flight exists to stop.
          this.confirmNextRun = true;
          this.scheduler?.request("manual");
        }
        return true;
      },
    });

    this.addCommand({
      id: "show-log",
      name: "Show sync log",
      callback: () => this.showLog(),
    });

    this.addRibbonIcon("refresh-cw", "Sync vault", () => this.scheduler?.request("manual"));

    this.registerFileTriggers();
    this.registerFocusTrigger();
    this.scheduler.startInterval();

    if (this.settings.syncOnStartup && this.isConfigured()) {
      // Let Obsidian finish loading the vault before adding work to it.
      this.app.workspace.onLayoutReady(() => this.scheduler?.request("startup"));
    }
  }

  override onunload(): void {
    this.scheduler?.stop();
  }

  // --- configuration ------------------------------------------------------

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<ObsydianSyncSettings>) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.scheduler?.updateConfig(this.schedulerConfig());
  }

  private schedulerConfig() {
    return {
      debounceMs: Math.max(1, this.settings.debounceSeconds) * 1000,
      intervalMs: Math.max(0, this.settings.intervalMinutes) * 60_000,
    };
  }

  private isConfigured(): boolean {
    return Boolean(this.settings.serverUrl && this.settings.token && this.settings.passphrase);
  }

  // --- triggers -----------------------------------------------------------

  private registerFileTriggers(): void {
    const onChange = (file: TAbstractFile) => {
      if (!this.settings.syncOnChange || !this.isConfigured()) return;
      if (file.path.startsWith(PLUGIN_DIR)) return;
      // Deliberately *not* gated on a sync being in flight. Our own writes do
      // fire these events, but suppressing them would also drop edits the user
      // makes during a long sync, leaving them unsynced until the next tick.
      // The follow-up run costs a scan and finds nothing to do, which is the
      // cheaper mistake — and it terminates, because a no-op sync writes
      // nothing and so fires no further events.
      this.scheduler?.requestDebounced("file-change");
    };

    this.registerEvent(this.app.vault.on("modify", onChange));
    this.registerEvent(this.app.vault.on("create", onChange));
    this.registerEvent(this.app.vault.on("delete", onChange));
    // `rename` has a different signature (it also receives the old path).
    this.registerEvent(this.app.vault.on("rename", (file) => onChange(file)));
  }

  private registerFocusTrigger(): void {
    const onFocus = () => {
      if (!this.settings.syncOnFocus || !this.isConfigured()) return;
      this.scheduler?.request("focus");
    };

    this.registerDomEvent(window, "focus", onFocus);
    // The one that matters on mobile: iOS and Android suspend background apps,
    // so returning to Obsidian is usually the first chance to sync at all.
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") onFocus();
    });
  }

  // --- syncing ------------------------------------------------------------

  private async keysFromSettings(): Promise<VaultKeys> {
    const api = this.buildApi();
    const meta = await api.meta();

    const cacheKey = `${this.settings.serverUrl}\u0000${meta.vaultId}\u0000${this.settings.passphrase}`;
    if (this.keys && this.keysFor === cacheKey) return this.keys;

    // Key derivation is deliberately expensive, so it is done once per
    // (server, vault, passphrase) rather than once per sync.
    const master = await deriveMasterKey(this.settings.passphrase, meta.kdf);
    this.keys = await deriveKeys(master);
    this.keysFor = cacheKey;
    return this.keys;
  }

  private buildApi(): SyncApi {
    return new SyncApi({
      baseUrl: this.settings.serverUrl,
      token: this.settings.token,
      transport: obsidianTransport(),
    });
  }

  async sync(reason: SyncReason, opts: { confirmMassDeletion?: boolean } = {}): Promise<void> {
    if (!this.isConfigured()) {
      if (reason === "manual") new Notice("Obsydian Sync: set the server, token and passphrase first.");
      return;
    }

    this.setStatus("syncing");
    try {
      const summary = await runSync({
        adapter: this.app.vault.adapter,
        api: this.buildApi(),
        keys: await this.keysFromSettings(),
        includeVaultConfig: this.settings.includeVaultConfig,
        exclude: this.settings.exclude,
        confirmMassDeletion: opts.confirmMassDeletion,
        onNote: (note: Note) => this.record(note.level, note.path ? `${note.path}: ${note.message}` : note.message),
      });

      this.lastSummary = summary;
      this.awaitingConfirmation = Boolean(summary.blocked);

      if (summary.blocked) {
        this.setStatus("blocked");
        this.record("warn", summary.blocked.reason);
        new Notice(
          `Obsydian Sync stopped: ${summary.blocked.reason}\n\n` +
            `Run "Sync, confirming pending deletions" to go ahead.`,
          15000,
        );
        return;
      }

      const moved =
        summary.pushed + summary.pulled + summary.deletedLocally + summary.pushedDeletions;
      if (moved > 0) {
        this.record(
          "info",
          `${reason}: pushed ${summary.pushed}, pulled ${summary.pulled}, ` +
            `trashed ${summary.deletedLocally}, deletions sent ${summary.pushedDeletions}`,
        );
      }

      // A file vanishing with no explanation is alarming, and the status bar
      // alone is too quiet for it — it reads the same after a sync that deleted
      // something as after one that did nothing.
      if (summary.deletedLocally > 0) {
        const n = summary.deletedLocally;
        new Notice(
          `Obsydian Sync moved ${n} file${n === 1 ? "" : "s"} to trash — ` +
            `deleted on another device. Recover from .trash if that was wrong.`,
          10000,
        );
      }

      this.setStatus("idle");
    } catch (error) {
      // A failed run tells us nothing about whether deletions are still
      // pending, and leaving the flag set would let a later confirm force
      // through deletions the user was never shown again.
      this.awaitingConfirmation = false;
      this.setStatus("error");
      if (reason === "manual" || error instanceof SyncError) {
        new Notice(`Obsydian Sync: ${describe(error)}`, 10000);
      }
      // Logged once, by the scheduler's onError. Every run reaches this through
      // the scheduler, so recording here too would halve the useful log window
      // during an outage.
      throw error;
    }
  }

  async testConnection(): Promise<void> {
    try {
      const api = this.buildApi();
      const meta = await api.meta();

      if (meta.kdfCheck === null) {
        new Notice(
          `Connected as "${meta.yourDeviceId}", but this vault has no passphrase set yet. ` +
            `Use Initialize if this is a new vault.`,
          10000,
        );
        return;
      }

      const keys = await deriveKeys(await deriveMasterKey(this.settings.passphrase, meta.kdf));
      const ok = await verifyKdfCheck(keys, meta.vaultId, meta.kdfCheck);

      new Notice(
        ok
          ? `Connected as "${meta.yourDeviceId}". Passphrase matches; ${meta.head} entries in the journal.`
          : `Connected as "${meta.yourDeviceId}", but the passphrase does not match this vault.`,
        10000,
      );
    } catch (error) {
      new Notice(`Obsydian Sync: ${describe(error)}`, 10000);
    }
  }

  async initializeVault(): Promise<void> {
    if (!this.settings.passphrase) {
      new Notice("Set a passphrase first.");
      return;
    }
    try {
      const api = this.buildApi();
      const meta = await api.meta();

      if (meta.kdfCheck !== null) {
        new Notice("This vault is already initialized; its passphrase cannot be replaced.", 10000);
        return;
      }

      // The server supplies the KDF parameters, and this is the one moment they
      // are not yet pinned by an existing kdfCheck. A server offering a trivial
      // iteration count here would weaken every key the vault ever uses, so
      // refuse rather than bake it in permanently.
      const saltBytes = meta.kdf.salt ? fromBase64(meta.kdf.salt).length : 0;
      if (meta.kdf.iterations < MIN_KDF_ITERATIONS || saltBytes < MIN_KDF_SALT_BYTES) {
        // Both parameters matter. An empty salt defeats the per-vault salting
        // entirely, so checking only the iteration count would be a guard that
        // covers one of the two things it exists to protect.
        new Notice(
          `Refusing to initialize: the server offers ${meta.kdf.iterations} KDF iterations and a ` +
            `${saltBytes}-byte salt (expected at least ${MIN_KDF_ITERATIONS} and ` +
            `${MIN_KDF_SALT_BYTES}). Check you are pointed at the right server.`,
          15000,
        );
        return;
      }

      const keys = await deriveKeys(await deriveMasterKey(this.settings.passphrase, meta.kdf));
      await api.initMeta(await makeKdfCheck(keys, meta.vaultId));

      // Drop any cached keys so the next sync re-derives against the new meta.
      this.keys = null;
      this.keysFor = "";

      new Notice(
        "Vault initialized. Store this passphrase somewhere safe — it cannot be recovered, " +
          "and without it the vault cannot be read.",
        15000,
      );
    } catch (error) {
      new Notice(`Obsydian Sync: ${describe(error)}`, 10000);
    }
  }

  // --- status and log -----------------------------------------------------

  private setStatus(state: "idle" | "syncing" | "error" | "blocked"): void {
    if (!this.statusBar) return;
    const s = this.lastSummary;
    switch (state) {
      case "syncing":
        this.statusBar.setText("⟳ Syncing…");
        break;
      case "error":
        this.statusBar.setText("⚠ Sync failed");
        break;
      case "blocked":
        this.statusBar.setText("⏸ Sync needs confirmation");
        break;
      case "idle": {
        if (!s) {
          this.statusBar.setText("Obsydian Sync");
          break;
        }
        // Say what the last sync actually did. "Synced (75 files)" is identical
        // whether a sync moved everything or nothing, which makes it useless
        // exactly when you are trying to tell the difference.
        const parts: string[] = [];
        if (s.pulled) parts.push(`↓${s.pulled}`);
        if (s.pushed) parts.push(`↑${s.pushed}`);
        if (s.deletedLocally) parts.push(`🗑${s.deletedLocally}`);
        if (s.pushedDeletions) parts.push(`✗${s.pushedDeletions}`);
        this.statusBar.setText(
          parts.length > 0
            ? `✓ ${s.scanned} files · ${parts.join(" ")}`
            : `✓ Synced (${s.scanned} files)`,
        );
        break;
      }
    }
  }

  private record(level: LogLine["level"], message: string): void {
    this.log.push({ at: Date.now(), level, message });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
  }

  private recordError(error: unknown): void {
    this.record("error", describe(error));
    console.error("[obsydian-sync]", error);
  }

  private showLog(): void {
    if (this.log.length === 0) {
      new Notice("Obsydian Sync: nothing logged yet.");
      return;
    }
    const recent = this.log.slice(-20).map((l) => {
      const time = new Date(l.at).toLocaleTimeString();
      return `${time} ${l.level === "info" ? "" : `[${l.level}] `}${l.message}`;
    });
    new Notice(recent.join("\n"), 20000);
    console.log("[obsydian-sync] full log:", this.log);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
