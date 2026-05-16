// Owns Yjs documents, websocket providers, and CodeMirror bindings.
// One Y.Doc per Markdown file; providers stay open until plugin unload
// so we remain in the awareness pool of every visited room.
//
// Since 0.10.0 the room name is `vaultId::<docId>`, where docId is an
// immutable per-note id (see doc-id.ts). The path is no longer part of the
// room identity, so moving or renaming a note keeps the exact same Y.Doc -
// no teardown, no re-seed, no chance of inheriting another note's stale room.

import { App, EventRef, MarkdownView, Notice, TFile } from 'obsidian';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { yCollab } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import { Compartment, StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { effectiveDisplayName, effectiveToken, type CoSyncSettings } from './types';
import { injectFrontmatterDocId } from './doc-id';

interface RoomEntry {
  room: string;
  docId: string;
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

// Fixed Yjs clientID used only for seed updates. Because every client uses the
// same id, seeding identical text yields a byte-identical Yjs update, so two
// clients seeding the same fresh room concurrently merge idempotently instead
// of duplicating the text. Real edits use each doc's own random clientID.
const SEED_CLIENT_ID = 1;

/** Build the idempotent seed update for a piece of text. */
function makeSeedUpdate(text: string): Uint8Array {
  const tmp = new Y.Doc();
  tmp.clientID = SEED_CLIENT_ID;
  tmp.getText('cosync').insert(0, text);
  const update = Y.encodeStateAsUpdate(tmp);
  tmp.destroy();
  return update;
}

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

  constructor(
    private app: App,
    private settings: CoSyncSettings,
    // Resolves a file to its immutable docId (owned by VaultIndexSync).
    private resolveDocId: (file: TFile) => Promise<string>,
  ) {
    this.renameEventRef = this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile && file.extension === 'md') {
        this.handleRename(file, oldPath);
      }
    });
  }

  /**
   * A rename/move no longer changes the room: the room is keyed by the
   * immutable docId, not the path. We only need to retarget where the
   * debounced disk save writes. The Y.Doc, provider and editor binding all
   * stay exactly as they are - the note keeps its content and history.
   */
  private handleRename(file: TFile, oldPath: string): void {
    for (const entry of this.rooms.values()) {
      if (entry.filePath === oldPath) {
        entry.filePath = file.path;
        console.log(`[cosync] rename: ${oldPath} -> ${file.path} (room ${entry.docId} unchanged)`);
        return;
      }
    }
  }

  private roomNameFor(docId: string): string {
    return `${this.settings.vaultId}${ROOM_SEP}${docId}`;
  }

  /** Open (or return existing) room for a file. Awaits initial IDB sync. */
  async openRoom(file: TFile, docId: string): Promise<RoomEntry> {
    const room = this.roomNameFor(docId);
    const existing = this.rooms.get(room);
    if (existing) {
      // Keep the save target current in case the file was moved while open.
      existing.filePath = file.path;
      return existing;
    }
    const inflight = this.openingRooms.get(room);
    if (inflight) return inflight;

    const promise = this.createRoom(file, room, docId).finally(() => {
      this.openingRooms.delete(room);
    });
    this.openingRooms.set(room, promise);
    return promise;
  }

  private async createRoom(file: TFile, room: string, docId: string): Promise<RoomEntry> {
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
      docId,
      filePath: file.path,
      doc,
      yText,
      undoMgr,
      provider,
      idb,
      awareness,
    };
    this.rooms.set(room, entry);

    // First-time seed: if Y.Text is still empty after server + IDB sync, fill
    // it from disk. The seed runs through makeSeedUpdate (fixed clientID), so
    // even if another client seeds the same fresh room at the same instant the
    // two updates are identical and merge without duplicating anything. We also
    // make sure the note's frontmatter carries its cosync-id.
    provider.once('synced', async () => {
      if (yText.length > 0) return;
      let text: string;
      try {
        text = await this.app.vault.read(file);
      } catch (e) {
        console.error('[cosync] initial seed read failed', e);
        return;
      }
      if (yText.length > 0) return; // content arrived while we were reading
      const seeded = injectFrontmatterDocId(text, docId);
      Y.applyUpdate(doc, makeSeedUpdate(seeded));
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
  async bindEditor(view: MarkdownView, entry: RoomEntry, binding: EditorBindingState): Promise<void> {
    const cm = (view.editor as unknown as { cm?: EditorView }).cm;
    if (!cm) {
      new Notice('[cosync] could not access CodeMirror editor');
      return;
    }
    // Always (re-)apply the local caret color, even on idempotent calls.
    this.applySelfCursorColor(cm);

    const previousDoc = binding.boundDoc.get(cm);
    if (previousDoc === entry.doc) return;

    // Claim the binding slot synchronously BEFORE any await so that the
    // file-open + active-leaf-change events that both fire on a note
    // switch don't each go through the full reconfigure path in parallel.
    // The second arrival sees boundDoc.get(cm) === entry.doc and returns.
    binding.boundDoc.set(cm, entry.doc);

    const ext = yCollab(entry.yText, entry.awareness, { undoManager: entry.undoMgr });

    // y-codemirror.next's YSyncPluginValue captures `this.conf.ytext` ONCE
    // in its constructor and only unobserves on destroy(). When we change
    // the bound Y.Doc, CM6 needs to actually destroy the old PluginValue
    // and construct a new one - otherwise the observer stays on the old
    // yText and edits to the new yText don't get broadcast.
    //
    // We use a fresh Compartment per binding (old one is reconfigured to
    // empty so its plugins go through destroy) and we yield to the
    // microtask queue between the two dispatches so CM6's plugin lifecycle
    // can run cleanly before we re-add yCollab.
    const oldComp = binding.compartment.get(cm);
    if (oldComp) {
      cm.dispatch({ effects: oldComp.reconfigure([]) });
    }
    await Promise.resolve();
    const freshComp = new Compartment();
    binding.compartment.set(cm, freshComp);
    cm.dispatch({ effects: StateEffect.appendConfig.of(freshComp.of(ext)) });
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
  async restoreFileText(file: TFile, docId: string, newText: string): Promise<void> {
    const entry = await this.openRoom(file, docId);
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
      let docId: string;
      try {
        docId = await this.resolveDocId(f);
      } catch (e) {
        console.warn('[cosync] eager-push: docId resolve failed for', f.path, e);
        continue;
      }
      const room = this.roomNameFor(docId);
      // Skip if a live room is already open OR a concurrent openRoom is in
      // flight. (Even if this races, the seed is idempotent - see createRoom.)
      if (this.rooms.has(room)) continue;
      if (this.openingRooms.has(room)) continue;
      try {
        await this.eagerSeedOne(f, room, docId, wsUrl, token);
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
  private async eagerSeedOne(
    file: TFile,
    room: string,
    docId: string,
    wsUrl: string,
    token: string,
  ): Promise<void> {
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
        const raw = await this.app.vault.read(file);
        if (yText.length === 0) {
          const seeded = injectFrontmatterDocId(raw, docId);
          Y.applyUpdate(doc, makeSeedUpdate(seeded));
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
