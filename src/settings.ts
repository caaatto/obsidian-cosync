import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type CoSyncPlugin from './main';
import { effectiveDisplayName, isLoggedIn } from './types';
import { login, logout, register } from './auth-client';

export class CoSyncSettingTab extends PluginSettingTab {
  // Password is held in-memory only; never persisted via saveSettings().
  private pendingPassword = '';

  constructor(app: App, private plugin: CoSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'CoSync — Live Collaboration' });
    containerEl.createEl('p', {
      text: 'Live co-editing via a self-hosted Yjs server. Share the same Server URL + Vault ID with collaborators; each person logs in with their own username + password.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Enabled')
      .setDesc('Turn live sync on or off without uninstalling.')
      .addToggle((t) => t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
        this.plugin.settings.enabled = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Your sync server, e.g. wss://obsd.clip.jetzt')
      .addText((t) => t
        .setPlaceholder('wss://obsd.clip.jetzt')
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async (v) => {
          this.plugin.settings.serverUrl = v.trim();
          await this.plugin.saveSettings();
        }));

    // ── Account section ─────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Account' });

    const loggedIn = isLoggedIn(this.plugin.settings);
    const status = loggedIn
      ? `✓ logged in as ${this.plugin.settings.username}`
      : (this.plugin.settings.adminToken ? '⚠ using admin token (no user account)' : '✗ not logged in');
    containerEl.createEl('p', { text: status, cls: 'setting-item-description' });

    new Setting(containerEl)
      .setName('Username')
      .setDesc('Your account name (3–32 chars, [a-zA-Z0-9_.-]).')
      .addText((t) => t
        .setValue(this.plugin.settings.username)
        .onChange(async (v) => {
          this.plugin.settings.username = v.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Password')
      .setDesc('Only typed here, never stored. Used once to obtain a session token.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('••••••••');
        t.onChange((v) => { this.pendingPassword = v; });
      });

    new Setting(containerEl)
      .setName('Login / Register')
      .setDesc('Login uses an existing account. Register creates a new one (server-whitelist required).')
      .addButton((b) => b.setButtonText('Login').setCta().onClick(async () => {
        await this.doLogin();
      }))
      .addButton((b) => b.setButtonText('Register').onClick(async () => {
        await this.doRegister();
      }))
      .addButton((b) => {
        b.setButtonText('Logout');
        b.setDisabled(!loggedIn);
        b.onClick(async () => { await this.doLogout(); });
      });

    new Setting(containerEl)
      .setName('Admin bypass token (optional)')
      .setDesc('Fallback shared secret matching AUTH_TOKEN on the server. Empty for normal users.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setValue(this.plugin.settings.adminToken).onChange(async (v) => {
          this.plugin.settings.adminToken = v.trim();
          await this.plugin.saveSettings();
        });
      });

    // ── Identity ────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Identity' });

    new Setting(containerEl)
      .setName('Display name')
      .setDesc(`Shown to others as your cursor label. Defaults to "${this.plugin.settings.username || 'your username'}".`)
      .addText((t) => t
        .setPlaceholder(this.plugin.settings.username || 'anon')
        .setValue(this.plugin.settings.displayName)
        .onChange(async (v) => {
          this.plugin.settings.displayName = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Cursor color')
      .addColorPicker((c) => c
        .setValue(this.plugin.settings.userColor)
        .onChange(async (v) => {
          this.plugin.settings.userColor = v;
          await this.plugin.saveSettings();
        }));

    // ── Vault ──────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Vault' });

    new Setting(containerEl)
      .setName('Vault ID')
      .setDesc('Identifies this vault on the server. Two vaults with the SAME ID sync together. Share this value with collaborators.')
      .addText((t) => t.setValue(this.plugin.settings.vaultId).onChange(async (v) => {
        this.plugin.settings.vaultId = v.trim();
        await this.plugin.saveSettings();
      }));
  }

  private async doLogin() {
    const s = this.plugin.settings;
    if (!s.serverUrl || !s.username || !this.pendingPassword) {
      new Notice('CoSync: server URL, username and password required.');
      return;
    }
    const res = await login(s.serverUrl, s.username, this.pendingPassword);
    if (!res.ok) {
      new Notice(`CoSync: ${res.error}`);
      return;
    }
    s.sessionToken = res.token;
    s.sessionExpiresAt = res.expiresAt;
    s.username = res.username;
    this.pendingPassword = '';
    await this.plugin.saveSettings();
    new Notice(`CoSync: logged in as ${res.username} (effective until ${new Date(res.expiresAt).toLocaleDateString()})`);
    this.display();
  }

  private async doRegister() {
    const s = this.plugin.settings;
    if (!s.serverUrl || !s.username || !this.pendingPassword) {
      new Notice('CoSync: server URL, username and password required.');
      return;
    }
    const res = await register(s.serverUrl, s.username, this.pendingPassword);
    if (!res.ok) {
      new Notice(`CoSync: register failed — ${res.error}`);
      return;
    }
    new Notice('CoSync: account created. Logging in…');
    await this.doLogin();
  }

  private async doLogout() {
    const s = this.plugin.settings;
    if (s.serverUrl && s.sessionToken) await logout(s.serverUrl, s.sessionToken);
    s.sessionToken = '';
    s.sessionExpiresAt = 0;
    await this.plugin.saveSettings();
    new Notice('CoSync: logged out.');
    this.display();
  }
}
