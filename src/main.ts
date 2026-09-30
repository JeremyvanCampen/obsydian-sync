import { Notice, Plugin, type TAbstractFile } from "obsidian";
import { SyncApi } from "./api.ts";
import { type VaultKeys, deriveKeys, deriveMasterKey, kdfProblem, makeKdfCheck, verifyKdfCheck } from "./crypto.ts";
import { obsidianTransport } from "./obsidian-transport.ts";
import type { Note } from "./reconcile.ts";
import { type SyncReason, SyncScheduler } from "./scheduler.ts";
import { DEFAULT_SETTINGS, type ObsydianSyncSettings, ObsydianSyncSettingTab } from "./settings.ts";
import { type SecretName, migrateLegacySecrets, readSecret, writeSecret } from "./secrets.ts";
import { type SyncScope, syncScope } from "./scan.ts";
import { SyncError, type SyncSummary, runSync } from "./sync.ts";
import type { VaultMeta } from "./types.ts";

const LOG_LIMIT = 200;


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
  /** Rebuilt whenever settings change; see syncScope. */
  private scope: SyncScope = syncScope(DEFAULT_SETTINGS);
  private statusBar: HTMLElement | null = null;
  /**
   * Derived keys, with what they were derived from. The server contributes the
   * KDF salt, so pointing at a different vault with the same passphrase must
   * re-derive — otherwise the stale keys fail verification and the user is told
   * their correct passphrase is wrong.
   */
  private cachedKeys: { for: string; keys: VaultKeys } | null = null;
  private readonly log: LogLine[] = [];
  private lastSummary: SyncSummary | null = null;

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
        // Derived rather than stored, so it cannot outlive the run it describes.
        if (!this.lastSummary?.blocked) return false;
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
    const saved = ((await this.loadData()) ?? {}) as Record<string, unknown>;

    // Earlier versions kept the token and passphrase in data.json. Move them to
    // secure storage, and rewrite data.json only if something actually moved.
    const { data, migrated, failed } = migrateLegacySecrets(this.app.secretStorage, saved);
    for (const f of failed) {
      console.error(`[obsydian-sync] could not move the ${f.name} to secure storage:`, f.error);
    }
    if (migrated.length > 0) await this.saveData(data);

    this.settings = { ...DEFAULT_SETTINGS, ...(data as Partial<ObsydianSyncSettings>) };
    this.scope = syncScope(this.settings);
  }

  getSecret(name: SecretName): string {
    return readSecret(this.app.secretStorage, name);
  }

  setSecret(name: SecretName, value: string): void {
    writeSecret(this.app.secretStorage, name, value);
    // A changed credential invalidates the derived keys; the cache key would
    // catch it too, but there is no reason to hold stale keys until then.
    if (name === "passphrase") this.cachedKeys = null;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.scope = syncScope(this.settings);
    this.scheduler?.updateConfig(this.schedulerConfig());
  }

  private schedulerConfig() {
    return {
      debounceMs: Math.max(1, this.settings.debounceSeconds) * 1000,
      intervalMs: Math.max(0, this.settings.intervalMinutes) * 60_000,
    };
  }

  private isConfigured(): boolean {
    return Boolean(this.settings.serverUrl && this.getSecret("token") && this.getSecret("passphrase"));
  }

  // --- triggers -----------------------------------------------------------

  private registerFileTriggers(): void {
    const onChange = (file: TAbstractFile) => {
      if (!this.settings.syncOnChange || !this.isConfigured()) return;
      if (!this.scope.includes(file.path)) return;
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

  /**
   * Keys for this vault. Takes the caller's meta rather than fetching its own,
   * so a sync costs one meta round trip, not two. Derivation is deliberately
   * expensive, so it runs once per (server, vault, passphrase, KDF).
   */
  private async keysFor(meta: VaultMeta): Promise<VaultKeys> {
    const passphrase = this.getSecret("passphrase");
    const id = [this.settings.serverUrl, meta.vaultId, meta.kdf.salt, meta.kdf.iterations, passphrase].join("\u0000");
    if (this.cachedKeys?.for === id) return this.cachedKeys.keys;

    const keys = await deriveKeys(await deriveMasterKey(passphrase, meta.kdf));
    this.cachedKeys = { for: id, keys };
    return keys;
  }

  private buildApi(): SyncApi {
    return new SyncApi({
      baseUrl: this.settings.serverUrl,
      token: this.getSecret("token"),
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
      const api = this.buildApi();
      const meta = await api.meta();
      const summary = await runSync({
        adapter: this.app.vault.adapter,
        api,
        meta,
        keys: await this.keysFor(meta),
        includeVaultConfig: this.settings.includeVaultConfig,
        exclude: this.settings.exclude,
        confirmMassDeletion: opts.confirmMassDeletion,
        onNote: (note: Note) => this.record(note.level, note.path ? `${note.path}: ${note.message}` : note.message),
      });

      this.lastSummary = summary;

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
      // pending, and keeping the old summary would let a later confirm force
      // through deletions the user was never shown again.
      this.lastSummary = null;
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

      const ok = await verifyKdfCheck(await this.keysFor(meta), meta.vaultId, meta.kdfCheck);

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
    const passphrase = this.getSecret("passphrase");
    if (!passphrase) {
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

      const problem = kdfProblem(meta.kdf);
      if (problem) {
        new Notice(`Refusing to initialize: ${problem}. Check you are pointed at the right server.`, 15000);
        return;
      }

      await api.initMeta(await makeKdfCheck(await this.keysFor(meta), meta.vaultId));

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
    // debug, not log: hidden at the console's default level, per the plugin guidelines.
    console.debug("[obsydian-sync] full log:", this.log);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
