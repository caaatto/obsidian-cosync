import { App, MarkdownView, Modal, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';
import * as Y from 'yjs';
import type { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { CoSyncSettingTab } from './settings';
import { SyncManager, type EditorBindingState } from './sync';
import { VaultIndexSync } from './vault-index';
import { listHistory, getSnapshot } from './auth-client';
import {
  CoSyncSettings,
  DEFAULT_SETTINGS,
  LOCAL_VAULT_ID,
  effectiveToken,
  isLocalActive,
  migrateSettings,
} from './types';

export default class CoSyncPlugin extends Plugin {
  settings!: CoSyncSettings;
  sync: SyncManager | null = null;
  vaultIndex: VaultIndexSync | null = null;
  // Plugin-scoped binding state. Survives SyncManager replacement so
  // saveSettings does not leak a fresh yCollab compartment into the editor
  // on every settings tick.
  private editorBinding: EditorBindingState = {
    compartment: new WeakMap<EditorView, Compartment>(),
    boundDoc: new WeakMap<EditorView, Y.Doc>(),
  };

  async onload() {
    await this.loadSettings();

    if (migrateSettings(this.settings)) {
      await this.saveData(this.settings);
    }

    this.addSettingTab(new CoSyncSettingTab(this.app, this));

    this.addRibbonIcon('users', 'CoSync: switch vault', () => {
      new VaultSwitcherModal(this.app, this).open();
    });

    this.addCommand({
      id: 'switch-vault',
      name: 'Switch active vault',
      callback: () => new VaultSwitcherModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'show-file-history',
      name: 'Show file history',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) return false;
        if (isLocalActive(this.settings)) return false;
        if (!checking) new FileHistoryModal(this.app, this, view.file).open();
        return true;
      },
    });

    await this.startSyncIfConfigured();

    this.registerEvent(this.app.workspace.on('file-open', this.handleFileOpen.bind(this)));
    this.registerEvent(this.app.workspace.on('active-leaf-change', this.handleLeafChange.bind(this)));

    this.app.workspace.onLayoutReady(() => this.bindCurrentLeaf());
  }

  async onunload() {
    await this.stopSync();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    await this.stopSync();
    await this.startSyncIfConfigured();
    this.bindCurrentLeaf();
  }

  /**
   * Lighter-weight settings save: persists settings + re-broadcasts the local
   * awareness identity to all open rooms. Use this for changes that should
   * NOT tear down and reconnect the sync (display name, cursor color, etc.).
   */
  async saveSettingsLight() {
    await this.saveData(this.settings);
    this.sync?.updateAwarenessIdentity();
  }

  private async stopSync() {
    if (this.vaultIndex) {
      await this.vaultIndex.stop();
      this.vaultIndex = null;
    }
    if (this.sync) {
      await this.sync.closeAll();
      this.sync = null;
    }
  }

  private async startSyncIfConfigured() {
    if (!this.settings.enabled) {
      console.log('[cosync] disabled in settings');
      return;
    }
    if (isLocalActive(this.settings)) {
      console.log('[cosync] local vault active - no sync');
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
    if (!this.settings.vaultId) {
      console.warn('[cosync] not started: vault id missing');
      return;
    }
    this.sync = new SyncManager(this.app, this.settings);
    this.vaultIndex = new VaultIndexSync(this.app, this.settings);
    try {
      await this.vaultIndex.start();
    } catch (e) {
      console.error('[cosync] vault index sync failed to start', e);
    }
    // Eager-push runs in the background: any .md the user has locally but has
    // not opened in this session still gets its content uploaded so other
    // clients receive non-empty stubs. Must wait for onLayoutReady because
    // app.vault.getMarkdownFiles() is empty until Obsidian has indexed the vault.
    const runEagerPush = () => {
      if (!this.sync) return;
      void this.sync.eagerPushAllFiles().catch((e) => {
        console.warn('[cosync] eager-push background task failed', e);
      });
    };
    if (this.app.workspace.layoutReady) {
      runEagerPush();
    } else {
      this.app.workspace.onLayoutReady(runEagerPush);
    }
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
      this.sync.bindEditor(view, entry, this.editorBinding);
    } catch (e) {
      console.error('[cosync] bindCurrentLeaf failed', e);
    }
  }

  // ── Vault switching ──────────────────────────────────────────────────

  /**
   * Switch the active vault. Snapshots the current vault's Markdown files into
   * a per-vault cache, removes them from the Obsidian vault, then restores any
   * previously cached files for the new vault. Sync is stopped first so that
   * the file deletions never propagate to the remote vault-index.
   */
  async switchVault(newVaultId: string): Promise<void> {
    const oldVaultId = this.settings.vaultId;
    if (newVaultId === oldVaultId) return;
    if (!this.settings.savedVaults.some((v) => v.id === newVaultId)) {
      throw new Error(`unknown vault id: ${newVaultId}`);
    }

    new Notice(`CoSync: switching vault…`);
    await this.stopSync();

    // 1. Snapshot current .md files into cache/<oldVaultId>/
    try {
      await this.snapshotVaultToCache(oldVaultId);
    } catch (e) {
      console.error('[cosync] snapshot failed - aborting switch', e);
      new Notice('CoSync: snapshot failed, switch aborted (no files removed).');
      await this.startSyncIfConfigured();
      return;
    }

    // 2. Delete current .md files from the Obsidian vault.
    try {
      await this.deleteAllMarkdownFromVault();
    } catch (e) {
      console.error('[cosync] vault clear failed', e);
      new Notice('CoSync: clearing the vault failed - see console.');
      // Continue: snapshot is safe, partial state is recoverable manually.
    }

    // 3. Persist new active vault id BEFORE restoring, so any side effects
    //    (e.g. file-create events) see the new active vault.
    this.settings.vaultId = newVaultId;
    await this.saveData(this.settings);

    // 4. Restore .md files from cache/<newVaultId>/ if present.
    try {
      await this.restoreVaultFromCache(newVaultId);
    } catch (e) {
      console.error('[cosync] restore failed', e);
      new Notice('CoSync: restoring cached files failed - see console.');
    }

    // 5. Restart sync against the new vault.
    await this.startSyncIfConfigured();
    this.bindCurrentLeaf();

    const name = this.settings.savedVaults.find((v) => v.id === newVaultId)?.name ?? newVaultId;
    new Notice(`CoSync: now on "${name}".`);
  }

  /** Remove a cache directory (e.g. when the user deletes a saved vault entry). */
  async dropVaultCache(vaultId: string): Promise<void> {
    const dir = this.cacheDirFor(vaultId);
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(dir))) return;
    await this.removeDirRecursive(dir);
  }

  private cacheRoot(): string {
    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return normalizePath(`${pluginDir}/vault-cache`);
  }

  private cacheDirFor(vaultId: string): string {
    return normalizePath(`${this.cacheRoot()}/${vaultId}`);
  }

  private async snapshotVaultToCache(vaultId: string): Promise<void> {
    if (vaultId === LOCAL_VAULT_ID) {
      // Local vault still gets snapshotted so its files survive the switch.
    }
    const adapter = this.app.vault.adapter;
    const dir = this.cacheDirFor(vaultId);

    // Wipe any stale cache first so removed files do not resurrect.
    if (await adapter.exists(dir)) {
      await this.removeDirRecursive(dir);
    }
    await this.ensureDir(dir);

    const files = this.app.vault.getMarkdownFiles();
    for (const f of files) {
      const content = await this.app.vault.read(f);
      const target = normalizePath(`${dir}/${f.path}`);
      const parent = target.slice(0, target.lastIndexOf('/'));
      await this.ensureDir(parent);
      await adapter.write(target, content);
    }
  }

  private async restoreVaultFromCache(vaultId: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const dir = this.cacheDirFor(vaultId);
    if (!(await adapter.exists(dir))) return;

    const allFiles = await this.listFilesRecursive(dir);
    for (const cachePath of allFiles) {
      if (!cachePath.endsWith('.md')) continue;
      const rel = cachePath.slice(dir.length + 1);
      const content = await adapter.read(cachePath);

      const lastSlash = rel.lastIndexOf('/');
      if (lastSlash > 0) {
        const parent = rel.slice(0, lastSlash);
        if (!this.app.vault.getAbstractFileByPath(parent)) {
          try { await this.app.vault.createFolder(parent); } catch { /* race */ }
        }
      }
      try {
        await this.app.vault.create(rel, content);
      } catch (e) {
        console.warn('[cosync] restore: create failed for', rel, e);
      }
    }
  }

  private async deleteAllMarkdownFromVault(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles().slice();
    for (const f of files) {
      try {
        await this.app.vault.delete(f);
      } catch (e) {
        console.warn('[cosync] delete failed for', f.path, e);
      }
    }
  }

  private async ensureDir(dir: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(dir)) return;
    // mkdir is not always recursive - walk parents.
    const parts = dir.split('/').filter(Boolean);
    let acc = '';
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      if (!(await adapter.exists(acc))) {
        try { await adapter.mkdir(acc); } catch { /* concurrent create */ }
      }
    }
  }

  private async listFilesRecursive(dir: string): Promise<string[]> {
    const adapter = this.app.vault.adapter;
    const out: string[] = [];
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop()!;
      const { files, folders } = await adapter.list(cur);
      out.push(...files);
      stack.push(...folders);
    }
    return out;
  }

  private async removeDirRecursive(dir: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(dir))) return;
    // Adapter has rmdir(path, recursive) on newer Obsidian. Fall back to manual walk.
    const rmdir = (adapter as unknown as { rmdir?: (p: string, recursive: boolean) => Promise<void> }).rmdir;
    if (typeof rmdir === 'function') {
      await rmdir.call(adapter, dir, true);
      return;
    }
    const { files, folders } = await adapter.list(dir);
    for (const f of files) await adapter.remove(f);
    for (const sub of folders) await this.removeDirRecursive(sub);
    try { await (adapter as unknown as { rmdir: (p: string) => Promise<void> }).rmdir(dir); } catch { /* ignore */ }
  }
}

class VaultSwitcherModal extends Modal {
  private selectedId: string;

  constructor(app: App, private plugin: CoSyncPlugin) {
    super(app);
    this.selectedId = plugin.settings.vaultId;
  }

  onOpen() {
    this.titleEl.setText('CoSync: switch vault');
    const { contentEl } = this;

    contentEl.createEl('p', {
      text: 'Pick a vault and click Switch. The current .md files will be cached, the target vault\'s files restored.',
      cls: 'setting-item-description',
    });

    const list = contentEl.createDiv({ cls: 'cosync-vault-switcher' });
    for (const v of this.plugin.settings.savedVaults) {
      const isActive = v.id === this.plugin.settings.vaultId;
      const row = list.createDiv({ cls: 'cosync-vault-switcher-row' });
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '0.5rem';
      row.style.padding = '0.25rem 0';
      row.style.cursor = 'pointer';

      const radio = row.createEl('input', { type: 'radio' });
      radio.name = 'cosync-vault';
      radio.value = v.id;
      radio.checked = (v.id === this.selectedId);

      const label = row.createEl('span');
      let labelText = v.name;
      if (v.id === LOCAL_VAULT_ID) labelText += ' (offline)';
      if (isActive) labelText += ' [active]';
      label.setText(labelText);

      const select = () => {
        this.selectedId = v.id;
        const radios = list.querySelectorAll<HTMLInputElement>('input[type="radio"]');
        radios.forEach((r) => { r.checked = (r.value === v.id); });
      };
      radio.addEventListener('change', select);
      row.addEventListener('click', (e) => { if (e.target !== radio) select(); });
    }

    const btns = contentEl.createDiv({ cls: 'modal-button-container' });
    const cancel = btns.createEl('button', { text: 'Cancel' });
    cancel.onclick = () => this.close();
    const ok = btns.createEl('button', { text: 'Switch', cls: 'mod-cta' });
    ok.onclick = async () => {
      const target = this.selectedId;
      this.close();
      if (target === this.plugin.settings.vaultId) return;
      try {
        await this.plugin.switchVault(target);
      } catch (e: any) {
        new Notice(`CoSync: switch failed - ${e?.message || e}`);
      }
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

class FileHistoryModal extends Modal {
  private previewEl?: HTMLPreElement;

  constructor(app: App, private plugin: CoSyncPlugin, private file: TFile) {
    super(app);
  }

  async onOpen() {
    this.titleEl.setText(`History: ${this.file.path}`);
    const { contentEl } = this;
    contentEl.createEl('p', { text: 'Loading snapshots...', cls: 'setting-item-description' });

    const s = this.plugin.settings;
    const token = effectiveToken(s);
    const res = await listHistory(s.serverUrl, token, s.vaultId, this.file.path);
    contentEl.empty();

    if (!res.ok) {
      contentEl.createEl('p', { text: `Could not load history: ${res.error}` });
      return;
    }
    if (res.snapshots.length === 0) {
      contentEl.createEl('p', {
        text: 'No snapshots yet. The server snapshots active edits every 60 seconds; come back after editing.',
      });
      return;
    }

    const desc = contentEl.createEl('p', {
      text: `${res.snapshots.length} snapshots available. Click a row to preview, "Restore" to bring that version into the live document.`,
      cls: 'setting-item-description',
    });
    desc.style.marginBottom = '0.5rem';

    const list = contentEl.createDiv();
    list.style.maxHeight = '240px';
    list.style.overflowY = 'auto';
    list.style.border = '1px solid var(--background-modifier-border)';
    list.style.borderRadius = '4px';
    list.style.marginBottom = '0.75rem';

    for (const snap of res.snapshots) {
      const row = list.createDiv();
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '0.5rem';
      row.style.padding = '0.4rem 0.6rem';
      row.style.borderBottom = '1px solid var(--background-modifier-border)';

      const label = row.createEl('span', { text: formatTimestamp(snap.takenAt) });
      label.style.flexGrow = '1';

      const sizeLabel = row.createEl('span', {
        text: `${(snap.byteSize / 1024).toFixed(1)} KB`,
        cls: 'setting-item-description',
      });
      sizeLabel.style.marginRight = '0.5rem';

      const previewBtn = row.createEl('button', { text: 'Preview' });
      previewBtn.onclick = () => void this.preview(snap.id);

      const restoreBtn = row.createEl('button', { text: 'Restore', cls: 'mod-cta' });
      restoreBtn.onclick = () => void this.confirmRestore(snap.id, snap.takenAt);
    }

    this.previewEl = contentEl.createEl('pre');
    this.previewEl.style.maxHeight = '240px';
    this.previewEl.style.overflow = 'auto';
    this.previewEl.style.background = 'var(--background-secondary)';
    this.previewEl.style.padding = '0.5rem';
    this.previewEl.style.borderRadius = '4px';
    this.previewEl.style.display = 'none';
    this.previewEl.style.fontSize = '0.85em';
  }

  private async preview(id: number): Promise<void> {
    const s = this.plugin.settings;
    const token = effectiveToken(s);
    const res = await getSnapshot(s.serverUrl, token, id);
    if (!res.ok) { new Notice(`Preview failed: ${res.error}`); return; }
    const text = decodeYTextFromUpdate(res.snapshot.state);
    if (this.previewEl) {
      this.previewEl.setText(text || '(empty)');
      this.previewEl.style.display = '';
      this.previewEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  private async confirmRestore(id: number, takenAt: number): Promise<void> {
    const filePath = this.file.path;
    const ok = await new Promise<boolean>((resolve) => {
      const m = new ConfirmModal(
        this.app,
        'Restore this version?',
        `Replace the current content of "${filePath}" with the version from ${formatTimestamp(takenAt)}. Other users editing live will see this as a single big edit.`,
        resolve,
      );
      m.open();
    });
    if (!ok) return;
    await this.applyRestore(id);
  }

  private async applyRestore(id: number): Promise<void> {
    const s = this.plugin.settings;
    const token = effectiveToken(s);
    const res = await getSnapshot(s.serverUrl, token, id);
    if (!res.ok) { new Notice(`Restore failed: ${res.error}`); return; }
    const text = decodeYTextFromUpdate(res.snapshot.state);

    const sync = this.plugin.sync;
    if (!sync) { new Notice('CoSync: sync manager not running, cannot restore.'); return; }
    try {
      await sync.restoreFileText(this.file, text);
      new Notice('CoSync: restored.');
      this.close();
    } catch (e: any) {
      new Notice(`Restore failed: ${e?.message || e}`);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

function decodeYTextFromUpdate(update: Uint8Array): string {
  const tmp = new Y.Doc();
  try {
    Y.applyUpdate(tmp, update);
    return tmp.getText('cosync').toString();
  } finally {
    tmp.destroy();
  }
}

class ConfirmModal extends Modal {
  private result = false;
  constructor(app: App, private title: string, private body: string, private onResolve: (v: boolean) => void) {
    super(app);
  }
  onOpen() {
    this.titleEl.setText(this.title);
    this.contentEl.createEl('p', { text: this.body });
    const btns = this.contentEl.createDiv({ cls: 'modal-button-container' });
    btns.createEl('button', { text: 'Cancel' }).onclick = () => { this.result = false; this.close(); };
    btns.createEl('button', { text: 'Confirm', cls: 'mod-cta' }).onclick = () => { this.result = true; this.close(); };
  }
  onClose() { this.onResolve(this.result); }
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${date} ${time}`;
}
