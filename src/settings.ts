import { type App, PluginSettingTab, Setting } from "obsidian";
import type ObsydianSyncPlugin from "./main.ts";
import { normalizeExcludePattern } from "./scan.ts";

export interface ObsydianSyncSettings {
  /** e.g. http://100.x.y.z:8787 — the tailnet address, not a public host. */
  serverUrl: string;
  // The bearer token and the passphrase are deliberately absent: they live in
  // SecretStorage, never in data.json. See secrets.ts.
  includeVaultConfig: boolean;
  exclude: string[];
  syncOnStartup: boolean;
  syncOnChange: boolean;
  syncOnFocus: boolean;
  debounceSeconds: number;
  intervalMinutes: number;
}

export const DEFAULT_SETTINGS: ObsydianSyncSettings = {
  serverUrl: "",
  includeVaultConfig: true,
  exclude: [],
  syncOnStartup: true,
  syncOnChange: true,
  syncOnFocus: true,
  debounceSeconds: 5,
  intervalMinutes: 5,
};

export class ObsydianSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ObsydianSyncPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("The sync server, e.g. http://100.x.y.z:8787. Reachable over Tailscale only.")
      .addText((text) =>
        text
          .setPlaceholder("http://100.x.y.z:8787")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Device token")
      .setDesc("This device's bearer token, from the server's config. Kept in secure storage.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(this.plugin.getSecret("token"))
          .onChange((value) => this.plugin.setSecret("token", value.trim()));
      });

    new Setting(containerEl)
      .setName("Passphrase")
      .setDesc(
        "Encrypts everything before it leaves this device. It must be identical on every " +
          "device, and it cannot be recovered or changed — losing it loses the vault. " +
          "Kept in secure storage.",
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(this.plugin.getSecret("passphrase"))
          // Not trimmed: the passphrase is used exactly as typed.
          .onChange((value) => this.plugin.setSecret("passphrase", value));
      });

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Checks the server, the token, and the passphrase without syncing anything.")
      .addButton((button) =>
        button.setButtonText("Test").onClick(() => void this.plugin.testConnection()),
      );

    new Setting(containerEl).setName("When to sync").setHeading();

    new Setting(containerEl)
      .setName("On startup")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncOnStartup).onChange(async (v) => {
          this.plugin.settings.syncOnStartup = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("After changes")
      .setDesc("Sync once editing has been quiet for a few seconds.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncOnChange).onChange(async (v) => {
          this.plugin.settings.syncOnChange = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("When the app regains focus")
      .setDesc(
        "The main sync moment on mobile: iOS and Android suspend background apps, so " +
          "returning to Obsidian is usually the first chance to sync.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncOnFocus).onChange(async (v) => {
          this.plugin.settings.syncOnFocus = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Quiet period")
      .setDesc("Seconds of no edits before an automatic sync.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.debounceSeconds)).onChange(async (value) => {
          const n = Number(value);
          if (Number.isFinite(n) && n >= 1) {
            this.plugin.settings.debounceSeconds = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Periodic sync")
      .setDesc("Minutes between syncs while Obsidian is open. 0 to disable.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.intervalMinutes)).onChange(async (value) => {
          const n = Number(value);
          if (Number.isFinite(n) && n >= 0) {
            this.plugin.settings.intervalMinutes = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl).setName("What to sync").setHeading();

    new Setting(containerEl)
      .setName("Vault settings (.obsidian)")
      .setDesc(
        "Appearance, hotkeys and plugin config. Per-device state (window layout, this " +
          "plugin's own folder) is always excluded.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.includeVaultConfig).onChange(async (v) => {
          this.plugin.settings.includeVaultConfig = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Additional exclusions")
      .setDesc("One pattern per line: 'folder/' for a subtree, '*.ext' by extension, or an exact path.")
      .addTextArea((area) =>
        area
          .setValue(this.plugin.settings.exclude.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.exclude = value
              .split("\n")
              .map(normalizeExcludePattern)
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Setup").setHeading();

    new Setting(containerEl)
      .setName("Initialize a new vault")
      .setDesc(
        "Only for a server with no passphrase set yet. This fixes the passphrase permanently " +
          "— it cannot be changed afterwards without abandoning everything already stored.",
      )
      .addButton((button) =>
        button
          .setButtonText("Initialize")
          .setWarning()
          .onClick(() => void this.plugin.initializeVault()),
      );
  }
}
