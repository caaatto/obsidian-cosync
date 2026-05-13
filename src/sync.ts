// Owns Yjs documents, websocket providers, and CodeMirror bindings.
// One Y.Doc per Markdown file; providers stay open until plugin unload
// so we remain in the awareness pool of every visited room.

import { App, MarkdownView, Notice, TFile } from 'obsidian';
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

export class SyncManager {
  private rooms = new Map<string, RoomEntry>();
  private editorCompartment = new WeakMap<EditorView, Compartment>();
  private editorBoundRoom = new WeakMap<EditorView, string>();

  constructor(private app: App, private settings: CoSyncSettings) {}

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
  bindEditor(view: MarkdownView, entry: RoomEntry) {
    const cm = (view.editor as unknown as { cm?: EditorView }).cm;
    if (!cm) {
      new Notice('[cosync] could not access CodeMirror editor');
      return;
    }
    if (this.editorBoundRoom.get(cm) === entry.room) return;

    const ext = yCollab(entry.yText, entry.awareness, { undoManager: entry.undoMgr });

    let comp = this.editorCompartment.get(cm);
    if (!comp) {
      comp = new Compartment();
      this.editorCompartment.set(cm, comp);
      cm.dispatch({ effects: StateEffect.appendConfig.of(comp.of(ext)) });
    } else {
      cm.dispatch({ effects: comp.reconfigure(ext) });
    }
    this.editorBoundRoom.set(cm, entry.room);
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
      if (this.rooms.has(room)) continue;
      try {
        await this.eagerSeedOne(f, room, wsUrl, token);
      } catch (e) {
        console.warn('[cosync] eager-push failed for', f.path, e);
      }
    }
    console.log('[cosync] eager-push: done');
  }

  private async eagerSeedOne(file: TFile, room: string, wsUrl: string, token: string): Promise<void> {
    const doc = new Y.Doc();
    const yText = doc.getText('cosync');
    const idb = new IndexeddbPersistence(room, doc);
    await idb.whenSynced;

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
      await idb.destroy().catch(() => {});
      doc.destroy();
    }
  }

  /** Tear everything down. Persists a final copy of each room to disk. */
  async closeAll(): Promise<void> {
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
