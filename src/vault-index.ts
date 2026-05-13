// Vault-level file index: a single Y.Doc per vault holds the set of known
// Markdown paths plus tombstones for paths that have been deleted. Each
// vault keeps its local file list in sync with the index; new files appear
// automatically on the other side as empty stubs whose contents fill in
// once the corresponding per-file SyncManager room opens.
//
// Schema: Y.Map<string, FileEntry> where FileEntry.deletedAt is the unix-ms
// timestamp at which the path was tombstoned. Absence of deletedAt (or the
// legacy `{ exists: true }` shape) means the path is alive.

import { App, EventRef, Notice, TFile } from 'obsidian';
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

function isAlive(entry: FileEntry | undefined): boolean {
  if (!entry) return false;
  return !entry.deletedAt;
}

function isTombstoned(entry: FileEntry | undefined): boolean {
  return !!entry?.deletedAt;
}

export class VaultIndexSync {
  private doc?: Y.Doc;
  private provider?: WebsocketProvider;
  private idb?: IndexeddbPersistence;
  private files?: Y.Map<FileEntry>;
  private vaultEventRefs: EventRef[] = [];

  // Set while we are mirroring remote → local; suppresses re-broadcasting our own writes.
  private suppressLocalEvents = false;

  constructor(private app: App, private settings: CoSyncSettings) {}

  async start(): Promise<void> {
    const room = `${this.settings.vaultId}::${INDEX_ROOM_KEY}`;
    const doc = new Y.Doc();
    const files = doc.getMap<FileEntry>('files');
    this.doc = doc;
    this.files = files;

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
    files.observe((event) => this.onRemoteChange(event));

    this.registerVaultListeners();
  }

  private registerVaultListeners() {
    const vault = this.app.vault;

    this.vaultEventRefs.push(vault.on('create', (file) => {
      if (this.suppressLocalEvents) return;
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      this.markAlive(file.path);
    }));

    this.vaultEventRefs.push(vault.on('rename', (file, oldPath) => {
      if (this.suppressLocalEvents) return;
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      const map = this.files;
      if (!map) return;
      this.doc?.transact(() => {
        map.set(oldPath, { deletedAt: Date.now() });
        map.set(file.path, {});
      });
    }));

    this.vaultEventRefs.push(vault.on('delete', (file) => {
      if (this.suppressLocalEvents) return;
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      this.files?.set(file.path, { deletedAt: Date.now() });
    }));
  }

  /** Insert / un-tombstone a path. Idempotent if the path is already alive. */
  private markAlive(path: string) {
    const map = this.files;
    if (!map) return;
    const existing = map.get(path);
    if (isAlive(existing)) return;
    map.set(path, {});
  }

  private reconcileAfterSync() {
    const map = this.files;
    if (!map) return;

    this.suppressLocalEvents = true;
    try {
      // 1) For every local .md, reconcile with the index.
      for (const f of this.app.vault.getMarkdownFiles()) {
        const entry = map.get(f.path);
        if (!entry) {
          // Genuinely new file: publish it.
          map.set(f.path, {});
          continue;
        }
        if (isTombstoned(entry)) {
          // The path was tombstoned. Decide: did the local user keep
          // modifying it AFTER the tombstone (offline edits)? If yes,
          // resurrect; if not, trash locally.
          const mtime = f.stat?.mtime ?? 0;
          const deletedAt = entry.deletedAt ?? 0;
          if (mtime > deletedAt) {
            // Offline edits after the delete: bring the file back.
            map.set(f.path, {});
          } else {
            // Stale local copy: move to trash, the remote delete wins.
            void this.handleRemoteDelete(f.path);
          }
        }
        // else: entry exists and is alive, nothing to do.
      }

      // 2) For every alive index entry without a local file: create a stub.
      for (const [path, entry] of map.entries()) {
        if (!isAlive(entry)) continue;
        if (!this.app.vault.getAbstractFileByPath(path)) {
          void this.createLocalStub(path);
        }
      }
    } finally {
      this.suppressLocalEvents = false;
    }
  }

  private onRemoteChange(event: Y.YMapEvent<FileEntry>) {
    const map = this.files;
    if (!map) return;
    this.suppressLocalEvents = true;
    try {
      for (const [path, change] of event.changes.keys) {
        if (change.action === 'delete') {
          // Pre-tombstone clients used Y.Map.delete; honor as a delete.
          void this.handleRemoteDelete(path);
          continue;
        }
        const current = map.get(path);
        const wasAlive = isAlive(change.oldValue as FileEntry | undefined);
        const nowAlive = isAlive(current);
        if (wasAlive && !nowAlive) {
          // Transitioned to tombstone: trash locally.
          void this.handleRemoteDelete(path);
        } else if (!wasAlive && nowAlive) {
          // Resurrected or freshly created: ensure local stub.
          if (!this.app.vault.getAbstractFileByPath(path)) {
            void this.createLocalStub(path);
          }
        }
        // Otherwise: no observable change in liveness.
      }
    } finally {
      this.suppressLocalEvents = false;
    }
  }

  /**
   * Mirror a remote file removal onto this client. We move the local file to
   * the OS trash (vault-relative .trash on platforms without one) rather than
   * hard-deleting it: the per-file Y.Doc snapshot history on the server has
   * the content for 30 days, but the local file is what the user actually
   * sees, so a soft delete gives them a chance to recover by accident.
   */
  private async handleRemoteDelete(path: string): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(path);
    if (!(af instanceof TFile)) return;
    this.suppressLocalEvents = true;
    try {
      await this.app.vault.trash(af, true);
      new Notice(`CoSync: removed "${path}" (moved to trash)`);
    } catch (e) {
      console.warn('[cosync] remote delete failed for', path, e);
    } finally {
      this.suppressLocalEvents = false;
    }
  }

  private async createLocalStub(path: string): Promise<void> {
    const vault = this.app.vault;
    if (vault.getAbstractFileByPath(path)) return;

    // Create parent folder chain if needed.
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash > 0) {
      const parent = path.slice(0, lastSlash);
      if (!vault.getAbstractFileByPath(parent)) {
        try {
          await vault.createFolder(parent);
        } catch {
          // already exists or race - ignore
        }
      }
    }
    try {
      await vault.create(path, '');
    } catch (e) {
      console.warn('[cosync] could not create local stub', path, e);
    }
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
  }
}
