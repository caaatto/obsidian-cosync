import { App, MarkdownView, Modal, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';
import * as Y from 'yjs';
import type { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { CoSyncSettingTab } from './settings';
import { SyncManager, unbindAllEditors, type EditorBindingState } from './sync';
import { VaultIndexSync } from './vault-index';
import { listHistory, getSnapshot } from './auth-client';
import { migrationDocId } from './doc-id';
import {
  CoSyncSettings,
  DEFAULT_SETTINGS,
  LOCAL_VAULT_ID,
  effectiveToken,
  isLocalActive,
  migrateSettings,
} from './types';

/**
 * Global handle used to detect duplicate plugin loads. BRAT's "check for
 * updates on startup" can load a newer build of the plugin without first
 * calling onunload() on the previous instance, which leaves two SyncManagers
 * fighting over the same EditorView - the symptom users see is "sync works
 * on the first file but breaks the moment I switch notes" plus a
 * "Yjs was already imported" console warning.
 *
 * Stored on globalThis so it survives module re-evaluation.
 */
const COSYNC_PLUGIN_GLOBAL_KEY = '__cosync_active_plugin_instance__';

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
    editors: new Set<EditorView>(),
  };
  private statusBarEl: HTMLElement | null = null;
  private presenceAwarenessListener: (() => void) | null = null;
  private currentActiveFile: string | null = null;
  // Serializes bindCurrentLeaf so concurrent file-open / leaf-change events
  // cannot interleave two bindEditor calls onto the same editor.
  private bindChain: Promise<void> = Promise.resolve();

  async onload() {
    // Defensive: if a previous plugin instance is still mounted in this
    // Obsidian process (e.g. because BRAT hot-loaded a new bundle without
    // disabling the old one first), forcibly unload it before we set up.
    // Otherwise two SyncManagers race for the same EditorView and live
    // sync breaks as soon as you switch notes.
    const previous = (globalThis as Record<string, unknown>)[COSYNC_PLUGIN_GLOBAL_KEY];
    if (previous && previous !== this && typeof (previous as { onunload?: unknown }).onunload === 'function') {
      console.warn('[cosync] previous plugin instance detected; unloading it before initializing this one');
      try {
        await (previous as { onunload: () => Promise<void> | void }).onunload();
      } catch (e) {
        console.error('[cosync] previous instance unload failed', e);
      }
    }
    (globalThis as Record<string, unknown>)[COSYNC_PLUGIN_GLOBAL_KEY] = this;

    await this.loadSettings();

    if (migrateSettings(this.settings)) {
      await this.saveData(this.settings);
    }

    this.addSettingTab(new CoSyncSettingTab(this.app, this));

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('cosync-presence');
    this.statusBarEl.style.display = 'none';
    this.statusBarEl.onclick = () => this.showPresencePopup();
    this.renderPresence();

    // Apply self caret color globally so every editor pane (not just the
    // active one) shows the user's chosen color, even before they focus it.
    document.body.style.setProperty('--cosync-self-cursor-color', this.settings.userColor || '#3eb6f7');

    this.addRibbonIcon('users', 'CoSync: switch vault', () => {
      new VaultSwitcherModal(this.app, this).open();
    });

    this.addCommand({
      id: 'switch-vault',
      name: 'Switch active vault',
      callback: () => new VaultSwitcherModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'reset-local-cache',
      name: 'Reset local cache for active vault (forces re-sync from server)',
      checkCallback: (checking) => {
        if (isLocalActive(this.settings)) return false;
        if (!checking) void this.confirmAndResetLocalCache();
        return true;
      },
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
    this.registerEvent(this.app.workspace.on('layout-change', () => this.renderFileExplorerHighlights()));

    this.app.workspace.onLayoutReady(() => this.bindCurrentLeaf());
  }

  async onunload() {
    // Detach our yCollab extension from every editor FIRST. If this instance
    // is being torn down by a hot reload, this is what prevents the dead
    // binding from running an edit loop alongside the new instance.
    unbindAllEditors(this.editorBinding);
    await this.stopSync();
    document.querySelectorAll('.cosync-file-presence').forEach((el) => el.remove());
    document.body.style.removeProperty('--cosync-self-cursor-color');
    const g = globalThis as Record<string, unknown>;
    if (g[COSYNC_PLUGIN_GLOBAL_KEY] === this) delete g[COSYNC_PLUGIN_GLOBAL_KEY];
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
    this.vaultIndex?.updateLocalUser();
    this.renderPresence();
    // Push the new color onto document.body so every open editor's caret
    // updates immediately (CSS variable inheritance).
    document.body.style.setProperty('--cosync-self-cursor-color', this.settings.userColor || '#3eb6f7');
  }

  private async stopSync() {
    this.detachPresenceListener();
    if (this.vaultIndex) {
      await this.vaultIndex.stop();
      this.vaultIndex = null;
    }
    if (this.sync) {
      await this.sync.closeAll();
      this.sync = null;
    }
    this.renderPresence();
    this.renderFileExplorerHighlights();
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
    // VaultIndexSync owns the path -> docId mapping; SyncManager needs it to
    // resolve which room a file belongs to, so create the index first.
    this.vaultIndex = new VaultIndexSync(this.app, this.settings);
    this.sync = new SyncManager(this.app, this.settings, (file) => this.resolveDocId(file));
    try {
      await this.vaultIndex.start();
      this.attachPresenceListener();
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

  /**
   * Serialized entry point for editor binding. A note switch fires file-open
   * AND active-leaf-change almost simultaneously; chaining the calls
   * guarantees one bindEditor finishes (and claims its compartment) before the
   * next begins, so two yCollab extensions can never interleave onto one
   * editor.
   */
  private bindCurrentLeaf(): Promise<void> {
    this.bindChain = this.bindChain
      .catch(() => { /* keep the chain alive */ })
      .then(() => this.doBindCurrentLeaf());
    return this.bindChain;
  }

  private async doBindCurrentLeaf() {
    if (!this.sync) {
      this.broadcastCurrentFile(null);
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) {
      this.broadcastCurrentFile(null);
      return;
    }
    this.broadcastCurrentFile(view.file.path);
    try {
      const docId = await this.resolveDocId(view.file);
      const entry = await this.sync.openRoom(view.file, docId);
      await this.sync.bindEditor(view, entry, this.editorBinding);
    } catch (e) {
      console.error('[cosync] bindCurrentLeaf failed', e);
    }
  }

  /**
   * Resolve a note's immutable docId. Delegates to VaultIndexSync (frontmatter
   * + index); only falls back to a bare deterministic id if the index is not
   * running, which should not happen while sync is active.
   */
  resolveDocId(file: TFile): Promise<string> {
    if (this.vaultIndex) return this.vaultIndex.resolveDocId(file);
    return Promise.resolve(migrationDocId(this.settings.vaultId, file.path));
  }

  private broadcastCurrentFile(path: string | null) {
    if (this.currentActiveFile === path) return;
    this.currentActiveFile = path;
    this.vaultIndex?.updateCurrentFile(path);
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

  /**
   * Confirm with user, then drop every local IndexedDB database that belongs
   * to the active vault (these are y-indexeddb caches of the Y.Docs). After
   * the cache is gone, sync is restarted; the rooms reload from the server
   * which becomes the single source of truth.
   *
   * Use case: a client's local cache got out of sync with the server (e.g.
   * old corrupt state from earlier plugin bugs) and edits don't propagate
   * symmetrically. This wipes the local cache so the next connect rebuilds
   * cleanly.
   */
  private async confirmAndResetLocalCache(): Promise<void> {
    const ok = await new Promise<boolean>((resolve) => {
      new ConfirmModal(
        this.app,
        'Reset local cache?',
        'This will delete every locally cached Y.Doc for the active vault and re-download state from the server. Unsynced offline edits will be lost. Other devices and the .md files on disk are not affected.',
        resolve,
      ).open();
    });
    if (!ok) return;

    new Notice('CoSync: resetting local cache...');
    await this.stopSync();

    const prefix = `${this.settings.vaultId}::`;
    let removed = 0;
    try {
      // indexedDB.databases() is supported in modern Chromium (Obsidian uses Electron).
      const all = await (indexedDB as unknown as {
        databases?: () => Promise<Array<{ name?: string }>>;
      }).databases?.();
      if (all) {
        for (const info of all) {
          if (!info.name || !info.name.startsWith(prefix)) continue;
          await new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(info.name!);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          });
          removed++;
        }
      }
    } catch (e) {
      console.warn('[cosync] reset cache failed', e);
    }

    await this.startSyncIfConfigured();
    this.bindCurrentLeaf();
    new Notice(`CoSync: cleared ${removed} cached room${removed === 1 ? '' : 's'} and restarted sync.`);
  }

  // Presence display (Google Docs-style avatar row in the status bar).

  private attachPresenceListener() {
    this.detachPresenceListener();
    const awareness = this.vaultIndex?.awareness;
    if (!awareness) return;
    const handler = () => {
      this.renderPresence();
      this.renderFileExplorerHighlights();
    };
    awareness.on('change', handler);
    this.presenceAwarenessListener = () => awareness.off('change', handler);
    // Re-broadcast our current file now that the awareness channel is live.
    if (this.currentActiveFile) {
      this.vaultIndex?.updateCurrentFile(this.currentActiveFile);
    }
    this.renderPresence();
    this.renderFileExplorerHighlights();
  }

  private detachPresenceListener() {
    if (this.presenceAwarenessListener) {
      try { this.presenceAwarenessListener(); } catch { /* ignore */ }
      this.presenceAwarenessListener = null;
    }
  }

  private collectPresenceUsers(): Array<{ id: number; name: string; color: string; isSelf: boolean }> {
    const aw = this.vaultIndex?.awareness;
    if (!aw) return [];
    const myId = aw.clientID;
    const out: Array<{ id: number; name: string; color: string; isSelf: boolean }> = [];
    aw.getStates().forEach((state, id) => {
      const u = (state as any).user;
      if (!u || typeof u.name !== 'string') return;
      out.push({
        id,
        name: u.name,
        color: typeof u.color === 'string' ? u.color : '#3eb6f7',
        isSelf: id === myId,
      });
    });
    // Self first, then others alphabetically.
    out.sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  private renderPresence() {
    const el = this.statusBarEl;
    if (!el) return;
    el.empty();

    if (!this.vaultIndex || isLocalActive(this.settings)) {
      el.style.display = 'none';
      return;
    }

    const users = this.collectPresenceUsers();
    if (users.length === 0) {
      el.style.display = 'inline-flex';
      el.style.alignItems = 'center';
      el.style.opacity = '0.6';
      el.style.fontSize = '0.85em';
      el.setText('CoSync: connecting...');
      return;
    }

    el.style.display = 'inline-flex';
    el.style.alignItems = 'center';
    el.style.gap = '3px';
    el.style.opacity = '1';
    el.style.cursor = 'pointer';
    el.style.fontSize = '';

    const MAX_VISIBLE = 5;
    const visible = users.slice(0, MAX_VISIBLE);
    for (const u of visible) {
      const dot = el.createSpan();
      dot.style.background = u.color;
      dot.style.color = pickReadableTextColor(u.color);
      dot.style.borderRadius = '50%';
      dot.style.width = '16px';
      dot.style.height = '16px';
      dot.style.display = 'inline-flex';
      dot.style.alignItems = 'center';
      dot.style.justifyContent = 'center';
      dot.style.fontSize = '0.65em';
      dot.style.fontWeight = 'bold';
      dot.style.border = u.isSelf ? '1.5px solid var(--text-normal)' : 'none';
      dot.setText((u.name.charAt(0) || '?').toUpperCase());
      dot.title = u.isSelf ? `${u.name} (you)` : u.name;
    }
    if (users.length > MAX_VISIBLE) {
      const more = el.createSpan({ text: `+${users.length - MAX_VISIBLE}` });
      more.style.marginLeft = '2px';
      more.style.fontSize = '0.85em';
      more.style.opacity = '0.8';
    }
  }

  private showPresencePopup() {
    const users = this.collectPresenceUsers();
    if (users.length === 0) return;
    new PresenceModal(this.app, users).open();
  }

  /**
   * Decorate the file-explorer side panel: every file currently held by some
   * collaborator (including this user) gets a row of small colored circles
   * indicating who is in it. Hover shows the name(s).
   */
  private renderFileExplorerHighlights() {
    // First, always wipe the previous decoration so a "user moved away" state
    // does not leave stale dots behind.
    document.querySelectorAll('.cosync-file-presence').forEach((el) => el.remove());

    const aw = this.vaultIndex?.awareness;
    if (!aw) return;

    const usersByPath = new Map<string, Array<{ name: string; color: string; isSelf: boolean }>>();
    const myId = aw.clientID;
    aw.getStates().forEach((state, id) => {
      const u = (state as any).user;
      const file = (state as any).currentFile;
      if (!u || typeof file !== 'string' || !file) return;
      const list = usersByPath.get(file) ?? [];
      list.push({
        name: typeof u.name === 'string' ? u.name : '?',
        color: typeof u.color === 'string' ? u.color : '#3eb6f7',
        isSelf: id === myId,
      });
      usersByPath.set(file, list);
    });

    if (usersByPath.size === 0) return;

    for (const [path, users] of usersByPath) {
      // `data-path` is set by Obsidian's FileExplorerView on every nav-file-title element.
      const titleEls = document.querySelectorAll<HTMLElement>(`.nav-file-title[data-path="${cssEscape(path)}"]`);
      titleEls.forEach((titleEl) => attachPresenceBadge(titleEl, users));
    }
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
  private docId = '';

  constructor(app: App, private plugin: CoSyncPlugin, private file: TFile) {
    super(app);
  }

  async onOpen() {
    this.titleEl.setText(`History: ${this.file.path}`);
    const { contentEl } = this;
    contentEl.createEl('p', { text: 'Loading snapshots...', cls: 'setting-item-description' });

    // History is keyed by the immutable docId (the server room name), not the
    // path - so a note's history survives moves and renames.
    this.docId = await this.plugin.resolveDocId(this.file);
    const s = this.plugin.settings;
    const token = effectiveToken(s);
    const res = await listHistory(s.serverUrl, token, s.vaultId, this.docId);
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
      await sync.restoreFileText(this.file, this.docId, text);
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

class PresenceModal extends Modal {
  constructor(app: App, private users: Array<{ id: number; name: string; color: string; isSelf: boolean }>) {
    super(app);
  }
  onOpen() {
    this.titleEl.setText(`Online in this vault (${this.users.length})`);
    const { contentEl } = this;
    for (const u of this.users) {
      const row = contentEl.createDiv();
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '0.5rem';
      row.style.padding = '0.3rem 0';
      const dot = row.createSpan();
      dot.style.background = u.color;
      dot.style.width = '14px';
      dot.style.height = '14px';
      dot.style.borderRadius = '50%';
      dot.style.flexShrink = '0';
      row.createEl('span', { text: u.isSelf ? `${u.name} (you)` : u.name });
    }
  }
  onClose() { this.contentEl.empty(); }
}

function attachPresenceBadge(
  titleEl: HTMLElement,
  users: Array<{ name: string; color: string; isSelf: boolean }>,
): void {
  const badge = document.createElement('span');
  badge.className = 'cosync-file-presence';
  badge.style.display = 'inline-flex';
  badge.style.gap = '2px';
  badge.style.marginLeft = 'auto';
  badge.style.paddingLeft = '6px';
  badge.style.alignItems = 'center';
  badge.style.flexShrink = '0';

  for (const u of users) {
    const dot = document.createElement('span');
    dot.style.width = '8px';
    dot.style.height = '8px';
    dot.style.borderRadius = '50%';
    dot.style.background = u.color;
    dot.style.display = 'inline-block';
    dot.style.border = u.isSelf ? '1.5px solid var(--text-normal)' : '1px solid rgba(0,0,0,0.2)';
    dot.style.boxSizing = 'content-box';
    dot.title = u.isSelf ? `${u.name} (you)` : u.name;
    badge.appendChild(dot);
  }

  // titleEl is the .nav-file-title; make it a flex row so the badge can push
  // to the right without overflowing the file name.
  if (!titleEl.style.display) titleEl.style.display = 'flex';
  if (!titleEl.style.alignItems) titleEl.style.alignItems = 'center';
  titleEl.appendChild(badge);
}

function cssEscape(s: string): string {
  // Minimal CSS attribute selector escape: backslash-escape quotes and backslash.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function pickReadableTextColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  // Relative luminance heuristic; light colors get black text, dark get white.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#000' : '#fff';
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${date} ${time}`;
}
