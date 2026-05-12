import { MarkdownView, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { CoSyncSettingTab } from './settings';
import { SyncManager } from './sync';
import { CoSyncSettings, DEFAULT_SETTINGS, effectiveToken } from './types';

export default class CoSyncPlugin extends Plugin {
  settings!: CoSyncSettings;
  sync: SyncManager | null = null;

  async onload() {
    await this.loadSettings();

    if (!this.settings.vaultId) {
      this.settings.vaultId = generateUUID();
      await this.saveData(this.settings);
    }

    this.addSettingTab(new CoSyncSettingTab(this.app, this));

    this.startSyncIfConfigured();

    this.registerEvent(this.app.workspace.on('file-open', this.handleFileOpen.bind(this)));
    this.registerEvent(this.app.workspace.on('active-leaf-change', this.handleLeafChange.bind(this)));

    this.app.workspace.onLayoutReady(() => this.bindCurrentLeaf());
  }

  async onunload() {
    if (this.sync) {
      await this.sync.closeAll();
      this.sync = null;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Restart the sync manager so the new settings take effect.
    if (this.sync) {
      await this.sync.closeAll();
      this.sync = null;
    }
    this.startSyncIfConfigured();
    this.bindCurrentLeaf();
  }

  private startSyncIfConfigured() {
    if (!this.settings.enabled) {
      console.log('[cosync] disabled in settings');
      return;
    }
    if (!this.settings.serverUrl) {
      console.warn('[cosync] not started: server URL missing');
      return;
    }
    if (!effectiveToken(this.settings)) {
      console.warn('[cosync] not started: log in via plugin settings first');
      return;
    }
    this.sync = new SyncManager(this.app, this.settings);
  }

  private async handleFileOpen(file: TFile | null) {
    if (!file || file.extension !== 'md') return;
    await this.bindCurrentLeaf();
  }

  private async handleLeafChange(_leaf: WorkspaceLeaf | null) {
    await this.bindCurrentLeaf();
  }

  private async bindCurrentLeaf() {
    if (!this.sync) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return;
    try {
      const entry = await this.sync.openRoom(view.file);
      this.sync.bindEditor(view, entry);
    } catch (e) {
      console.error('[cosync] bindCurrentLeaf failed', e);
    }
  }
}

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for older runtimes.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
