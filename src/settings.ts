import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type CoSyncPlugin from './main';
import { LOCAL_VAULT_ID, isLoggedIn } from './types';
import { login, logout, register } from './auth-client';

export class CoSyncSettingTab extends PluginSettingTab {
  // Password and invite code are held in-memory only; never persisted via saveSettings().
  private pendingPassword = '';
  private pendingInviteCode = '';

  // Add-vault form state, held until the user clicks "Add".
  private newVaultName = '';
  private newVaultId = '';

  constructor(app: App, private plugin: CoSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'CoSync - Live Collaboration' });
    containerEl.createEl('p', {
      text: 'Live co-editing via a self-hosted Yjs server. Save multiple vaults and switch between them; each switch moves your local .md files into a per-vault cache.',
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
      .setName('Invite code (only for first registration)')
      .setDesc('You receive a one-time code from the server admin. Required to create the account, not needed for login.')
      .addText((t) => {
        t.setPlaceholder('e.g. A1B2C3D4E5F6A1B2');
        t.onChange((v) => { this.pendingInviteCode = v.trim(); });
      });

    new Setting(containerEl)
      .setName('Login / Register')
      .setDesc('Login uses an existing account. Register creates a new one (invite code required).')
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

    // ── Vaults ──────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Vaults' });
    containerEl.createEl('p', {
      text: 'Switch between saved vaults. Your local .md files are moved into a per-vault cache when you switch; on switching back, the cached files are restored. The "Local" vault is offline-only and never syncs.',
      cls: 'setting-item-description',
    });

    const activeVault = this.plugin.settings.savedVaults.find((v) => v.id === this.plugin.settings.vaultId);
    new Setting(containerEl)
      .setName('Active vault')
      .setDesc(`Currently active: "${activeVault?.name ?? this.plugin.settings.vaultId}".`)
      .addDropdown((d) => {
        for (const v of this.plugin.settings.savedVaults) {
          d.addOption(v.id, v.id === LOCAL_VAULT_ID ? `${v.name} (offline)` : v.name);
        }
        d.setValue(this.plugin.settings.vaultId);
        d.onChange(async (newId) => {
          if (newId === this.plugin.settings.vaultId) return;
          const ok = await this.confirmSwitch(newId);
          if (!ok) {
            d.setValue(this.plugin.settings.vaultId);
            return;
          }
          await this.plugin.switchVault(newId);
          this.display();
        });
      });

    // List of saved vaults with delete buttons (except the local one).
    const listEl = containerEl.createDiv({ cls: 'cosync-vault-list' });
    for (const v of this.plugin.settings.savedVaults) {
      const isLocal = v.id === LOCAL_VAULT_ID;
      const isActive = v.id === this.plugin.settings.vaultId;
      const row = new Setting(listEl)
        .setName(`${v.name}${isActive ? '  (active)' : ''}`)
        .setDesc(isLocal ? 'Offline-only vault. Cannot be removed.' : v.id);

      if (!isLocal) {
        row.addButton((b) => b
          .setButtonText('Copy ID')
          .onClick(async () => {
            try {
              await navigator.clipboard.writeText(v.id);
              new Notice('CoSync: vault ID copied.');
            } catch {
              new Notice('CoSync: could not copy.');
            }
          }));
        row.addButton((b) => b
          .setButtonText('Remove')
          .setWarning()
          .setDisabled(isActive)
          .onClick(async () => {
            if (isActive) return;
            const ok = await confirmDialog(this.app,
              `Remove "${v.name}" from saved vaults?`,
              'Its cached local copy will be deleted. Files on the sync server are not affected.');
            if (!ok) return;
            this.plugin.settings.savedVaults = this.plugin.settings.savedVaults.filter((x) => x.id !== v.id);
            await this.plugin.saveSettings();
            await this.plugin.dropVaultCache(v.id);
            new Notice(`CoSync: removed "${v.name}".`);
            this.display();
          }));
      }
    }

    // Add new vault.
    containerEl.createEl('h4', { text: 'Add vault' });
    new Setting(containerEl)
      .setName('Vault name')
      .setDesc('Friendly label, shown in the dropdown.')
      .addText((t) => t
        .setPlaceholder('e.g. Friends')
        .setValue(this.newVaultName)
        .onChange((v) => { this.newVaultName = v; }));
    new Setting(containerEl)
      .setName('Vault ID')
      .setDesc('Paste the shared vault code, or generate a new one.')
      .addText((t) => t
        .setPlaceholder('UUID / shared code')
        .setValue(this.newVaultId)
        .onChange((v) => { this.newVaultId = v.trim(); }))
      .addButton((b) => b.setButtonText('Generate').onClick(() => {
        this.newVaultId = generateUUID();
        this.display();
      }));

    new Setting(containerEl)
      .addButton((b) => b
        .setButtonText('Add vault')
        .setCta()
        .onClick(async () => {
          const name = this.newVaultName.trim();
          const id = this.newVaultId.trim();
          if (!name || !id) {
            new Notice('CoSync: name and vault ID are required.');
            return;
          }
          if (id === LOCAL_VAULT_ID) {
            new Notice('CoSync: that ID is reserved.');
            return;
          }
          if (this.plugin.settings.savedVaults.some((v) => v.id === id)) {
            new Notice('CoSync: a vault with that ID is already saved.');
            return;
          }
          this.plugin.settings.savedVaults.push({ id, name });
          await this.plugin.saveSettings();
          this.newVaultName = '';
          this.newVaultId = '';
          new Notice(`CoSync: added "${name}".`);
          this.display();
        }));
  }

  private async confirmSwitch(newId: string): Promise<boolean> {
    const next = this.plugin.settings.savedVaults.find((v) => v.id === newId);
    const curr = this.plugin.settings.savedVaults.find((v) => v.id === this.plugin.settings.vaultId);
    return confirmDialog(
      this.app,
      `Switch to "${next?.name ?? newId}"?`,
      `All .md files currently in this vault will be moved into a cache for "${curr?.name ?? 'the current vault'}", and any previously cached files for the target will be restored. Editor sessions will be reconnected.`,
    );
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
    if (!this.pendingInviteCode) {
      new Notice('CoSync: invite code required for registration.');
      return;
    }
    const res = await register(s.serverUrl, s.username, this.pendingPassword, this.pendingInviteCode);
    if (!res.ok) {
      new Notice(`CoSync: register failed - ${res.error}`);
      return;
    }
    this.pendingInviteCode = '';
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

function confirmDialog(app: App, title: string, body: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new (class extends Modal {
      private result = false;
      onOpen() {
        this.titleEl.setText(title);
        this.contentEl.createEl('p', { text: body });
        const btns = this.contentEl.createDiv({ cls: 'modal-button-container' });
        const cancel = btns.createEl('button', { text: 'Cancel' });
        cancel.onclick = () => { this.result = false; this.close(); };
        const ok = btns.createEl('button', { text: 'Continue', cls: 'mod-cta' });
        ok.onclick = () => { this.result = true; this.close(); };
      }
      onClose() { resolve(this.result); }
    })(app);
    modal.open();
  });
}

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
