// Vault-level file + folder index: a single Y.Doc per vault holds the set of
// known Markdown paths and folder paths, plus tombstones for paths that have
// been deleted. Each vault keeps its local file/folder tree in sync with the
// index. Renames are detected on the receiver as a single transaction that
// contains exactly one tombstone and one new-alive entry; in that case we
// call vault.rename so the local file/folder keeps its content and identity
// instead of going through trash + create + empty stub.
//
// Schema:
//   files:   Y.Map<string, FileEntry>     key = relative .md path
//   folders: Y.Map<string, FolderEntry>   key = relative folder path
// Both entry types use deletedAt (unix-ms) as a tombstone marker; an entry
// with no deletedAt (or the legacy { exists: true }) is alive.

import { App, EventRef, Notice, TFile, TFolder } from 'obsidian';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import type { Awareness } from 'y-protocols/awareness';
import { effectiveDisplayName, effectiveToken, type CoSyncSettings } from './types';

const INDEX_ROOM_KEY = '__INDEX__';

interface FileEntry {
  // Legacy field from pre-0.9 plugins, kept for backwards compat.
  exists?: true;
  // Unix-ms timestamp; if set, this path is tombstoned (deleted).
  deletedAt?: number;
}

interface FolderEntry {
  deletedAt?: number;
}

function isFileAlive(e: FileEntry | undefined): boolean {
  return !!e && !e.deletedAt;
}
function isFolderAlive(e: FolderEntry | undefined): boolean {
  return !!e && !e.deletedAt;
}

export class VaultIndexSync {
  private doc?: Y.Doc;
  private provider?: WebsocketProvider;
  private idb?: IndexeddbPersistence;
  private files?: Y.Map<FileEntry>;
  private folders?: Y.Map<FolderEntry>;
  private vaultEventRefs: EventRef[] = [];

  // Re-entrancy counter. >0 means we are currently applying remote changes
  // to the local vault, so our vault.* event listeners must NOT re-broadcast.
  // A boolean version had a bug: nested vault.trash/vault.rename calls each
  // wrapped the flag, and the inner finally clobbered the outer suppression.
  // A counter survives any nesting depth.
  private suppressDepth = 0;
  private get suppressed(): boolean { return this.suppressDepth > 0; }

  constructor(private app: App, private settings: CoSyncSettings) {}

  async start(): Promise<void> {
    const room = `${this.settings.vaultId}::${INDEX_ROOM_KEY}`;
    const doc = new Y.Doc();
    const files = doc.getMap<FileEntry>('files');
    const folders = doc.getMap<FolderEntry>('folders');
    this.doc = doc;
    this.files = files;
    this.folders = folders;

    this.idb = new IndexeddbPersistence(room, doc);
    await this.idb.whenSynced;

    const token = effectiveToken(this.settings);
    if (!token) throw new Error('not authenticated');

    const wsUrl = this.settings.serverUrl.replace(/\/+$/, '');
    this.provider = new WebsocketProvider(wsUrl, room, doc, {
      params: { token },
      connect: true,
    });
    this.applyLocalUser();

    this.provider.once('synced', () => this.reconcileAfterSync());
    files.observe((event) => this.onRemoteFileChange(event));
    folders.observe((event) => this.onRemoteFolderChange(event));

    this.registerVaultListeners();
  }

  private registerVaultListeners() {
    const vault = this.app.vault;

    this.vaultEventRefs.push(vault.on('create', (af) => {
      if (this.suppressed) return;
      if (af instanceof TFile && af.extension === 'md') {
        this.markFileAlive(af.path);
        return;
      }
      if (af instanceof TFolder && af.path && af.path !== '/') {
        this.markFolderAlive(af.path);
      }
    }));

    this.vaultEventRefs.push(vault.on('rename', (af, oldPath) => {
      if (this.suppressed) return;
      const doc = this.doc;
      if (!doc) return;
      if (af instanceof TFile && af.extension === 'md') {
        const fmap = this.files;
        if (!fmap) return;
        doc.transact(() => {
          fmap.set(oldPath, { deletedAt: Date.now() });
          fmap.set(af.path, {});
        });
        return;
      }
      if (af instanceof TFolder) {
        const fmap = this.folders;
        if (!fmap) return;
        doc.transact(() => {
          fmap.set(oldPath, { deletedAt: Date.now() });
          fmap.set(af.path, {});
        });
      }
    }));

    this.vaultEventRefs.push(vault.on('delete', (af) => {
      if (this.suppressed) return;
      if (af instanceof TFile && af.extension === 'md') {
        this.files?.set(af.path, { deletedAt: Date.now() });
        return;
      }
      if (af instanceof TFolder) {
        this.folders?.set(af.path, { deletedAt: Date.now() });
      }
    }));
  }

  /** Insert / un-tombstone a path. Idempotent if the path is already alive. */
  private markFileAlive(path: string) {
    const map = this.files;
    if (!map) return;
    if (isFileAlive(map.get(path))) return;
    map.set(path, {});
  }

  private markFolderAlive(path: string) {
    const map = this.folders;
    if (!map) return;
    if (isFolderAlive(map.get(path))) return;
    map.set(path, {});
  }

  private reconcileAfterSync() {
    const files = this.files;
    const folders = this.folders;
    if (!files || !folders) return;

    // Folders first so child files can find their parents during stub create.
    // 1a) Publish local folders missing from the index, or resurrect ones the
    //     index tombstoned (we have no folder mtime, so always resurrect if
    //     the folder still exists locally - the contained files have their
    //     own tombstone/mtime logic).
    for (const folder of this.collectLocalFolders()) {
      const entry = folders.get(folder.path);
      if (!entry || !isFolderAlive(entry)) {
        folders.set(folder.path, {});
      }
    }

    // 1b) Create alive remote folders that are missing locally.
    for (const [path, entry] of folders.entries()) {
      if (!isFolderAlive(entry)) continue;
      if (!this.app.vault.getAbstractFileByPath(path)) {
        void this.ensureFolderExists(path);
      }
    }

    // 2a) Reconcile local files with index.
    for (const f of this.app.vault.getMarkdownFiles()) {
      const entry = files.get(f.path);
      if (!entry) {
        files.set(f.path, {});
        continue;
      }
      if (!isFileAlive(entry)) {
        const mtime = f.stat?.mtime ?? 0;
        const deletedAt = entry.deletedAt ?? 0;
        if (mtime > deletedAt) {
          // Offline edits after the delete: bring the file back.
          files.set(f.path, {});
        } else {
          // Stale local copy: trash, the remote delete wins.
          void this.handleRemoteFileDelete(f.path);
        }
      }
    }

    // 2b) Create alive remote file stubs that are missing locally.
    for (const [path, entry] of files.entries()) {
      if (!isFileAlive(entry)) continue;
      if (!this.app.vault.getAbstractFileByPath(path)) {
        void this.createLocalStub(path);
      }
    }
  }

  private collectLocalFolders(): TFolder[] {
    const out: TFolder[] = [];
    const root = this.app.vault.getRoot();
    const walk = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          out.push(child);
          walk(child);
        }
      }
    };
    walk(root);
    return out;
  }

  private onRemoteFileChange(event: Y.YMapEvent<FileEntry>) {
    const map = this.files;
    if (!map) return;

    const tombstoned: string[] = [];
    const newlyAlive: string[] = [];
    for (const [path, change] of event.changes.keys) {
      if (change.action === 'delete') {
        // Pre-tombstone clients used Y.Map.delete; treat as a delete.
        tombstoned.push(path);
        continue;
      }
      const wasAlive = isFileAlive(change.oldValue as FileEntry | undefined);
      const nowAlive = isFileAlive(map.get(path));
      if (wasAlive && !nowAlive) tombstoned.push(path);
      else if (!wasAlive && nowAlive) newlyAlive.push(path);
    }

    // Rename signal: exactly one tombstone + one new-alive in a single
    // transaction. Use vault.rename so the local file keeps its content and
    // the editor view stays attached. Falling back to trash + empty stub
    // would briefly blank the file until the per-file Y.Doc room re-seeds.
    if (tombstoned.length === 1 && newlyAlive.length === 1) {
      void this.handleRemoteFileRename(tombstoned[0], newlyAlive[0]);
      return;
    }

    for (const path of tombstoned) void this.handleRemoteFileDelete(path);
    for (const path of newlyAlive) {
      if (!this.app.vault.getAbstractFileByPath(path)) {
        void this.createLocalStub(path);
      }
    }
  }

  private onRemoteFolderChange(event: Y.YMapEvent<FolderEntry>) {
    const map = this.folders;
    if (!map) return;

    const tombstoned: string[] = [];
    const newlyAlive: string[] = [];
    for (const [path, change] of event.changes.keys) {
      if (change.action === 'delete') {
        tombstoned.push(path);
        continue;
      }
      const wasAlive = isFolderAlive(change.oldValue as FolderEntry | undefined);
      const nowAlive = isFolderAlive(map.get(path));
      if (wasAlive && !nowAlive) tombstoned.push(path);
      else if (!wasAlive && nowAlive) newlyAlive.push(path);
    }

    if (tombstoned.length === 1 && newlyAlive.length === 1) {
      void this.handleRemoteFolderRename(tombstoned[0], newlyAlive[0]);
      return;
    }

    for (const path of tombstoned) void this.handleRemoteFolderDelete(path);
    for (const path of newlyAlive) {
      if (!this.app.vault.getAbstractFileByPath(path)) {
        void this.ensureFolderExists(path);
      }
    }
  }

  private async handleRemoteFileRename(oldPath: string, newPath: string): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(oldPath);
    if (!(af instanceof TFile)) {
      // No local file at old path (maybe a parent folder rename already
      // moved it). Make sure something exists at the new path.
      if (!this.app.vault.getAbstractFileByPath(newPath)) {
        await this.createLocalStub(newPath);
      }
      return;
    }
    this.suppressDepth++;
    try {
      await this.ensureParentFolder(newPath);
      await this.app.vault.rename(af, newPath);
    } catch (e) {
      console.warn('[cosync] remote file rename failed', oldPath, '->', newPath, e);
    } finally {
      this.suppressDepth--;
    }
  }

  private async handleRemoteFolderRename(oldPath: string, newPath: string): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(oldPath);
    if (!(af instanceof TFolder)) {
      if (!this.app.vault.getAbstractFileByPath(newPath)) {
        await this.ensureFolderExists(newPath);
      }
      return;
    }
    this.suppressDepth++;
    try {
      await this.ensureParentFolder(newPath);
      await this.app.vault.rename(af, newPath);
    } catch (e) {
      console.warn('[cosync] remote folder rename failed', oldPath, '->', newPath, e);
    } finally {
      this.suppressDepth--;
    }
  }

  /**
   * Mirror a remote file removal onto this client. The local file goes to the
   * OS trash rather than being hard-deleted: per-file snapshots cover 30 days
   * server-side, but a soft local delete lets the user recover an accident.
   */
  private async handleRemoteFileDelete(path: string): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(path);
    if (!(af instanceof TFile)) return;
    this.suppressDepth++;
    try {
      await this.app.vault.trash(af, true);
      new Notice(`CoSync: removed "${path}" (moved to trash)`);
    } catch (e) {
      console.warn('[cosync] remote delete failed for', path, e);
    } finally {
      this.suppressDepth--;
    }
  }

  /**
   * Mirror a remote folder removal. Only auto-trash empty folders: a folder
   * that still holds local files probably means those files have not yet
   * been tombstoned on this side (or the user is keeping them). Their own
   * delete propagation will eventually run, after which Obsidian collapses
   * empty parents on its own.
   */
  private async handleRemoteFolderDelete(path: string): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(path);
    if (!(af instanceof TFolder)) return;
    if (af.children.length > 0) return;
    this.suppressDepth++;
    try {
      await this.app.vault.trash(af, true);
    } catch (e) {
      console.warn('[cosync] remote folder delete failed for', path, e);
    } finally {
      this.suppressDepth--;
    }
  }

  private async createLocalStub(path: string): Promise<void> {
    const vault = this.app.vault;
    if (vault.getAbstractFileByPath(path)) return;
    await this.ensureParentFolder(path);
    this.suppressDepth++;
    try {
      await vault.create(path, '');
    } catch (e) {
      console.warn('[cosync] could not create local stub', path, e);
    } finally {
      this.suppressDepth--;
    }
  }

  private async ensureFolderExists(path: string): Promise<void> {
    const vault = this.app.vault;
    if (vault.getAbstractFileByPath(path)) return;
    await this.ensureParentFolder(path);
    this.suppressDepth++;
    try {
      await vault.createFolder(path);
    } catch {
      // already exists or race - ignore
    } finally {
      this.suppressDepth--;
    }
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash <= 0) return;
    await this.ensureFolderExists(path.slice(0, lastSlash));
  }

  /** Awareness for the vault-wide presence channel. Undefined if not started. */
  get awareness(): Awareness | undefined {
    return this.provider?.awareness;
  }

  /** Re-broadcast the local user identity (name + color) on this awareness channel. */
  updateLocalUser(): void {
    this.applyLocalUser();
  }

  /**
   * Publish which file this client currently has open. Other clients listen
   * to this to decorate the file explorer with the live user's color.
   * Pass `null` when nothing markdown-y is active.
   */
  updateCurrentFile(path: string | null): void {
    if (!this.provider) return;
    this.provider.awareness.setLocalStateField('currentFile', path);
  }

  private applyLocalUser(): void {
    if (!this.provider) return;
    const color = this.settings.userColor || '#3eb6f7';
    this.provider.awareness.setLocalStateField('user', {
      name: effectiveDisplayName(this.settings),
      color,
      colorLight: color + '33',
    });
  }

  async stop(): Promise<void> {
    for (const ref of this.vaultEventRefs) {
      this.app.vault.offref(ref);
    }
    this.vaultEventRefs = [];
    if (this.provider) { this.provider.destroy(); this.provider = undefined; }
    if (this.idb)      { await this.idb.destroy(); this.idb = undefined; }
    if (this.doc)      { this.doc.destroy(); this.doc = undefined; }
    this.files = undefined;
    this.folders = undefined;
  }
}
