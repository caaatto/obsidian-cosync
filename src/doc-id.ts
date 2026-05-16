// Stable per-note document identity.
//
// Before 0.10.0 the Yjs room for a note was `vaultId::<path>`. That made the
// path the identity: moving a note onto a path that some *other* note had used
// before resurrected that other note's stale CRDT state (server LevelDB and
// local IndexedDB rooms are never garbage-collected), and a freshly-renamed
// note landed in an empty room that two clients could seed independently.
//
// Since 0.10.0 each note carries an immutable `docId`. The room is
// `vaultId::<docId>`, so a move/rename never changes the room. The docId lives
// in the note's frontmatter (`cosync-id:`) as the primary store and is mirrored
// into the vault index as a fallback.

/** Frontmatter key under which the immutable doc id is stored. */
export const COSYNC_ID_KEY = 'cosync-id';

// Matches a leading YAML frontmatter block: `---\n ... \n---\n`.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Extract the `cosync-id` value from a note's frontmatter, or null if the note
 * has no frontmatter block or no such key.
 */
export function parseFrontmatterDocId(content: string): string | null {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return null;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    const mm = /^cosync-id:\s*("?)([^"\r\n]+)\1\s*$/.exec(line);
    if (mm) {
      const v = mm[2].trim();
      return v.length > 0 ? v : null;
    }
  }
  return null;
}

/**
 * Return `content` with `cosync-id: <docId>` guaranteed present in the
 * frontmatter. Existing frontmatter gets the line added (any stale cosync-id
 * line is replaced); a note without frontmatter gets a fresh block prepended.
 * Idempotent: if the id already matches, the content is returned unchanged.
 */
export function injectFrontmatterDocId(content: string, docId: string): string {
  if (parseFrontmatterDocId(content) === docId) return content;
  const idLine = `${COSYNC_ID_KEY}: ${docId}`;
  const m = FRONTMATTER_RE.exec(content);
  if (m) {
    const block = m[1]
      .split(/\r?\n/)
      .filter((l) => !/^\s*cosync-id:/.test(l))
      .concat(idLine)
      .join('\n');
    return `---\n${block}\n---\n` + content.slice(m[0].length);
  }
  return `---\n${idLine}\n---\n` + content;
}

// cyrb53: a fast, well-distributed 53-bit string hash. Deterministic across
// machines and JS engines, which is exactly what the migration id needs.
function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Deterministic doc id for a note that predates docId tracking (migration).
 *
 * Every client computes the *same* id from `vaultId + path`, so a pre-existing
 * note converges onto one shared room without any coordination. Used ONLY when
 * a note has neither a frontmatter id nor an index entry yet; once the id is
 * frozen into the frontmatter it is read from there and never recomputed, so a
 * later move (which changes the path) does not change the id.
 *
 * NOTE: never use this for freshly created notes - a reused path must get a
 * *fresh* id (see generateDocId) or it would inherit the previous note's room.
 */
export function migrationDocId(vaultId: string, path: string): string {
  const key = `${vaultId}::${path}`;
  const a = cyrb53(key, 1).toString(16).padStart(14, '0');
  const b = cyrb53(key, 2).toString(16).padStart(14, '0');
  return `m-${a}${b}`;
}

/** Fresh random doc id for a newly created note. */
export function generateDocId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return `d-${c.randomUUID()}`;
  // Fallback for environments without crypto.randomUUID.
  const rand = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `d-${rand()}${rand()}${rand()}${rand()}`;
}
