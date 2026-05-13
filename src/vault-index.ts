// Vault-level file index: a single Y.Doc per vault holds the set of known
// Markdown paths. Each vault keeps its local file list in sync with the index;
// new files appear automatically on the other side as empty stubs whose
// contents fill in once the corresponding per-file SyncManager room opens.
//
// Delete is intentionally NOT propagated - removing the index entry when the
// last user has the file would risk silent data loss. Users delete locally.

import { App, EventRef, Notice, TFile } from 'obsidian';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import type { Awareness } from 'y-protocols/awareness';
import { effectiveDisplayName, effectiveToken, type CoSyncSettings } from './types';

const INDEX_ROOM_KEY = '__INDEX__';

interface FileEntry { exists: true }

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
      this.addPath(file.path);
    }));

    this.vaultEventRefs.push(vault.on('rename', (file, oldPath) => {
      if (this.suppressLocalEvents) return;
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      const map = this.files;
      if (!map) return;
      this.doc?.transact(() => {
        map.delete(oldPath);
        map.set(file.path, { exists: true });
      });
    }));

    this.vaultEventRefs.push(vault.on('delete', (file) => {
      if (this.suppressLocalEvents) return;
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      this.files?.delete(file.path);
    }));
  }

  private addPath(path: string) {
    if (!this.files || this.files.has(path)) return;
    this.files.set(path, { exists: true });
  }

  private reconcileAfterSync() {
    const map = this.files;
    if (!map) return;

    // 1) Push any local-only paths up into the index.
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!map.has(f.path)) map.set(f.path, { exists: true });
    }

    // 2) For every index entry missing locally, create an empty stub.
    this.suppressLocalEvents = true;
    try {
      for (const path of map.keys()) {
        if (!this.app.vault.getAbstractFileByPath(path)) {
          void this.createLocalStub(path);
        }
      }
    } finally {
      this.suppressLocalEvents = false;
    }
  }

  private onRemoteChange(event: Y.YMapEvent<FileEntry>) {
    if (!this.files) return;
    this.suppressLocalEvents = true;
    try {
      for (const [path, change] of event.changes.keys) {
        if (change.action === 'add' || change.action === 'update') {
          if (!this.app.vault.getAbstractFileByPath(path)) {
            void this.createLocalStub(path);
          }
        } else if (change.action === 'delete') {
          void this.handleRemoteDelete(path);
        }
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
