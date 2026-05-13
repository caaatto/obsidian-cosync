// Owns Yjs documents, websocket providers, and CodeMirror bindings.
// One Y.Doc per Markdown file; providers stay open until plugin unload
// so we remain in the awareness pool of every visited room.

import { App, EventRef, MarkdownView, Notice, TFile } from 'obsidian';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { yCollab } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import { Compartment, StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { effectiveDisplayName, effectiveToken, type CoSyncSettings } from './types';

interface RoomEntry {
  room: string;
  filePath: string;
  doc: Y.Doc;
  yText: Y.Text;
  undoMgr: Y.UndoManager;
  provider: WebsocketProvider;
  idb: IndexeddbPersistence;
  awareness: Awareness;
  saveTimer?: ReturnType<typeof setTimeout>;
}

const ROOM_SEP = '::';
const SAVE_DEBOUNCE_MS = 1000;

export interface EditorBindingState {
  // The plugin owns these so they survive SyncManager replacement on
  // saveSettings. Otherwise each settings change would append a new yCollab
  // compartment to every open editor, leaking bindings that point at
  // destroyed Y.Docs.
  compartment: WeakMap<EditorView, Compartment>;
  boundDoc: WeakMap<EditorView, Y.Doc>;
}

export class SyncManager {
  private rooms = new Map<string, RoomEntry>();
  // Tracks rooms whose openRoom() is in flight. Without this, file-open and
  // active-leaf-change events for the same file race and produce two parallel
  // IndexeddbPersistence + WebsocketProvider instances on the same room,
  // which results in "Caught error while handling a Yjs update" and a
  // disconnect/reconnect loop.
  private openingRooms = new Map<string, Promise<RoomEntry>>();
  private renameEventRef: EventRef;

  constructor(private app: App, private settings: CoSyncSettings) {
    this.renameEventRef = this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile && file.extension === 'md') {
        void this.handleRename(file, oldPath);
      }
    });
  }

  /**
   * When Obsidian renames a file, the running Y.Doc keeps its old room name
   * forever otherwise. Drop the old room so the next openRoom() under the new
   * path creates a fresh Y.Doc and seeds it from disk (Obsidian moves the
   * file content along during a rename, so disk is the source of truth).
   */
  private async handleRename(file: TFile, oldPath: string): Promise<void> {
    const oldRoom = `${this.settings.vaultId}${ROOM_SEP}${oldPath}`;
    const entry = this.rooms.get(oldRoom);
    if (!entry) return;

    console.log(`[cosync] rename: closing ${oldRoom}, will reopen at new path`);

    // Force-flush latest Y.Text content to the new path before tearing down,
    // covering the (rare) case where the debounced save had not yet fired.
    if (entry.saveTimer) {
      clearTimeout(entry.saveTimer);
      entry.saveTimer = undefined;
    }
    try {
      const text = entry.yText.toString();
      await this.app.vault.modify(file, text).catch(() => {});
    } catch { /* best effort */ }

    try {
      entry.provider.destroy();
      await entry.idb.destroy().catch(() => {});
      entry.doc.destroy();
    } catch (e) {
      console.warn('[cosync] rename: cleanup error', e);
    }
    this.rooms.delete(oldRoom);
  }

  private roomNameFor(file: TFile): string {
    return `${this.settings.vaultId}${ROOM_SEP}${file.path}`;
  }

  private filePathFromRoom(room: string): string {
    const idx = room.indexOf(ROOM_SEP);
    return idx >= 0 ? room.slice(idx + ROOM_SEP.length) : room;
  }

  /** Open (or return existing) room for a file. Awaits initial IDB sync. */
  async openRoom(file: TFile): Promise<RoomEntry> {
    const room = this.roomNameFor(file);
    const existing = this.rooms.get(room);
    if (existing) return existing;
    const inflight = this.openingRooms.get(room);
    if (inflight) return inflight;

    const promise = this.createRoom(file, room).finally(() => {
      this.openingRooms.delete(room);
    });
    this.openingRooms.set(room, promise);
    return promise;
  }

  private async createRoom(file: TFile, room: string): Promise<RoomEntry> {
    const doc = new Y.Doc();
    const yText = doc.getText('cosync');
    const undoMgr = new Y.UndoManager(yText);

    const idb = new IndexeddbPersistence(room, doc);
    await idb.whenSynced;

    const wsUrl = this.settings.serverUrl.replace(/\/+$/, '');
    const token = effectiveToken(this.settings);
    if (!token) {
      throw new Error('not authenticated - login in CoSync settings');
    }
    const provider = new WebsocketProvider(wsUrl, room, doc, {
      params: { token },
      connect: true,
    });

    const awareness = provider.awareness;
    awareness.setLocalStateField('user', {
      name: effectiveDisplayName(this.settings),
      color: this.settings.userColor || '#3eb6f7',
      colorLight: (this.settings.userColor || '#3eb6f7') + '33',
    });

    const entry: RoomEntry = {
      room,
      filePath: file.path,
      doc,
      yText,
      undoMgr,
      provider,
      idb,
      awareness,
    };
    this.rooms.set(room, entry);

    // First-time seed: if Y.Text is empty after server+IDB sync, fill with file contents.
    provider.once('synced', async () => {
      if (yText.length === 0) {
        try {
          const text = await this.app.vault.read(file);
          if (text.length > 0) {
            doc.transact(() => yText.insert(0, text));
          }
        } catch (e) {
          console.error('[cosync] initial seed read failed', e);
        }
      }
    });

    // Push merged CRDT state back to disk so Obsidian's search/graph stays current.
    yText.observe(() => this.scheduleSave(entry));

    provider.on('status', (ev: { status: string }) => {
      console.log(`[cosync] room=${room} status=${ev.status}`);
    });
    provider.on('connection-error', (ev: Event) => {
      console.warn(`[cosync] room=${room} connection-error`, ev);
    });

    return entry;
  }

  private scheduleSave(entry: RoomEntry) {
    if (entry.saveTimer) clearTimeout(entry.saveTimer);
    entry.saveTimer = setTimeout(async () => {
      const f = this.app.vault.getAbstractFileByPath(entry.filePath);
      if (!(f instanceof TFile)) return;
      const content = entry.yText.toString();
      try {
        await this.app.vault.modify(f, content);
      } catch (e) {
        console.error('[cosync] modify failed', e);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Bind the active CodeMirror editor to the given room.
   * Uses a Compartment so we can cleanly reconfigure when the user switches files
   * within the same leaf (Obsidian reuses the same EditorView).
   */
  bindEditor(view: MarkdownView, entry: RoomEntry, binding: EditorBindingState) {
    const cm = (view.editor as unknown as { cm?: EditorView }).cm;
    if (!cm) {
      new Notice('[cosync] could not access CodeMirror editor');
      return;
    }
    // Always (re-)apply the local caret color, even on idempotent calls.
    // styles.css reads the CSS var from cm.dom to color the native caret
    // in the user's presence color.
    this.applySelfCursorColor(cm);
    // Identity check uses the Y.Doc reference, not the room name string.
    // The room name stays stable across SyncManager restarts (vaultId::path)
    // but the underlying Y.Doc is replaced; comparing strings would skip
    // the reconfigure and leave the editor bound to a destroyed Y.Doc.
    if (binding.boundDoc.get(cm) === entry.doc) return;

    const ext = yCollab(entry.yText, entry.awareness, { undoManager: entry.undoMgr });

    let comp = binding.compartment.get(cm);
    if (!comp) {
      comp = new Compartment();
      binding.compartment.set(cm, comp);
      cm.dispatch({ effects: StateEffect.appendConfig.of(comp.of(ext)) });
    } else {
      cm.dispatch({ effects: comp.reconfigure(ext) });
    }
    binding.boundDoc.set(cm, entry.doc);
  }

  /**
   * Re-broadcast the local user identity (name + color) to every live room.
   * Called when settings change so other clients see the new cursor color
   * without having to reconnect or wait for the next focus change.
   */
  updateAwarenessIdentity(): void {
    const color = this.settings.userColor || '#3eb6f7';
    const user = {
      name: effectiveDisplayName(this.settings),
      color,
      colorLight: color + '33',
    };
    for (const entry of this.rooms.values()) {
      entry.awareness.setLocalStateField('user', user);
    }
  }

  /**
   * Set the CSS variable that drives the native caret color (see styles.css).
   * Also writes to document.body so every open editor inherits the same
   * value, not just the one we are currently binding.
   */
  private applySelfCursorColor(cm: EditorView): void {
    const color = this.settings.userColor || '#3eb6f7';
    cm.dom.style.setProperty('--cosync-self-cursor-color', color);
    document.body.style.setProperty('--cosync-self-cursor-color', color);
  }

  /**
   * Replace a file's Y.Text content with the given text. Other live editors
   * will see this as one big edit; the change is broadcast through the
   * existing provider so it lands on the server too. Caller is expected to
   * have asked the user for confirmation already.
   */
  async restoreFileText(file: TFile, newText: string): Promise<void> {
    const entry = await this.openRoom(file);
    entry.doc.transact(() => {
      if (entry.yText.length > 0) entry.yText.delete(0, entry.yText.length);
      if (newText.length > 0) entry.yText.insert(0, newText);
    });
    // scheduleSave (debounced) will flush the new content back to disk.
  }

  /**
   * Make sure every local .md has its content on the server. For files that
   * have not been opened in this session (and so have no live room), open a
   * short-lived room, seed Y.Text from disk if it is empty, then close it
   * again. Files whose room is already live are skipped.
   */
  async eagerPushAllFiles(): Promise<void> {
    const wsUrl = this.settings.serverUrl.replace(/\/+$/, '');
    const token = effectiveToken(this.settings);
    if (!token) return;

    const files = this.app.vault.getMarkdownFiles();
    console.log(`[cosync] eager-push: ${files.length} files`);
    for (const f of files) {
      const room = this.roomNameFor(f);
      // Skip if a live room is already open OR a concurrent openRoom is in
      // flight. Running eagerSeedOne against the same room while openRoom is
      // also creating a Y.Doc for it caused duplicate Y.Docs to sync to the
      // server, producing the asymmetric-sync symptom (one side's updates
      // referenced state the other side had no idea about).
      if (this.rooms.has(room)) continue;
      if (this.openingRooms.has(room)) continue;
      try {
        await this.eagerSeedOne(f, room, wsUrl, token);
      } catch (e) {
        console.warn('[cosync] eager-push failed for', f.path, e);
      }
    }
    console.log('[cosync] eager-push: done');
  }

  /**
   * Open a short-lived per-file room WITHOUT IndexeddbPersistence. Sharing
   * the IDB key with the user-opened Y.Doc for the same file led to two
   * IDB connections writing into the same database concurrently, which
   * corrupted the locally-loaded state on subsequent loads. Server is the
   * source of truth here anyway - we only need the WebSocket transport.
   */
  private async eagerSeedOne(file: TFile, room: string, wsUrl: string, token: string): Promise<void> {
    const doc = new Y.Doc();
    const yText = doc.getText('cosync');

    const provider = new WebsocketProvider(wsUrl, room, doc, {
      params: { token },
      connect: true,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('initial sync timeout')), 5000);
        provider.once('synced', () => { clearTimeout(timer); resolve(); });
      });

      if (yText.length === 0) {
        const content = await this.app.vault.read(file);
        if (content.length > 0) {
          doc.transact(() => yText.insert(0, content));
          // Give the provider a beat to flush the update to the server.
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    } finally {
      provider.destroy();
      doc.destroy();
    }
  }

  /** Tear everything down. Persists a final copy of each room to disk. */
  async closeAll(): Promise<void> {
    this.app.vault.offref(this.renameEventRef);
    for (const entry of this.rooms.values()) {
      try {
        if (entry.saveTimer) {
          clearTimeout(entry.saveTimer);
          entry.saveTimer = undefined;
        }
        const f = this.app.vault.getAbstractFileByPath(entry.filePath);
        if (f instanceof TFile) {
          await this.app.vault.modify(f, entry.yText.toString()).catch(() => {});
        }
        entry.provider.destroy();
        await entry.idb.destroy();
        entry.doc.destroy();
      } catch (e) {
        console.error('[cosync] closeAll error', e);
      }
    }
    this.rooms.clear();
  }
}
