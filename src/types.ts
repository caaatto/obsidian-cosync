export const LOCAL_VAULT_ID = '__local__';

export interface SavedVault {
  id: string;          // LOCAL_VAULT_ID for the offline-only vault, otherwise UUID / shared code
  name: string;        // friendly label shown in the UI
}

export interface CoSyncSettings {
  // Connection
  serverUrl: string;       // e.g. wss://obsd.clip.jetzt - auth endpoints use https://...

  // Account (V2)
  username: string;        // login + default display name
  sessionToken: string;    // opaque token from /auth/login (persisted)
  sessionExpiresAt: number; // epoch ms; 0 = never logged in

  // Admin bypass (V1 fallback). If set AND sessionToken empty, used directly.
  adminToken: string;

  // Identity in the editor
  displayName: string;     // optional override, defaults to username
  userColor: string;       // hex

  // Vault wiring
  vaultId: string;         // currently active vault - entry in savedVaults
  savedVaults: SavedVault[];
  enabled: boolean;
}

export const DEFAULT_SETTINGS: CoSyncSettings = {
  serverUrl: '',
  username: '',
  sessionToken: '',
  sessionExpiresAt: 0,
  adminToken: '',
  displayName: '',
  userColor: '#3eb6f7',
  vaultId: LOCAL_VAULT_ID,
  savedVaults: [{ id: LOCAL_VAULT_ID, name: 'Local (no sync)' }],
  enabled: true,
};

export function effectiveDisplayName(s: CoSyncSettings): string {
  return (s.displayName || s.username || 'anon').trim() || 'anon';
}

/** Token the WS connection should present (?token=...). Empty → not authenticated. */
export function effectiveToken(s: CoSyncSettings): string {
  if (s.sessionToken && s.sessionExpiresAt > Date.now() + 60_000) return s.sessionToken;
  if (s.adminToken) return s.adminToken;
  return '';
}

export function isLoggedIn(s: CoSyncSettings): boolean {
  return !!s.sessionToken && s.sessionExpiresAt > Date.now() + 60_000;
}

export function isLocalActive(s: CoSyncSettings): boolean {
  return s.vaultId === LOCAL_VAULT_ID;
}

export function activeVault(s: CoSyncSettings): SavedVault | undefined {
  return s.savedVaults.find((v) => v.id === s.vaultId);
}

/**
 * Bring a possibly-stale settings object up to the current schema in place.
 * Returns true if anything changed (so callers can persist).
 */
export function migrateSettings(s: CoSyncSettings): boolean {
  let changed = false;
  if (!Array.isArray(s.savedVaults)) {
    s.savedVaults = [];
    changed = true;
  }
  if (!s.savedVaults.some((v) => v.id === LOCAL_VAULT_ID)) {
    s.savedVaults.unshift({ id: LOCAL_VAULT_ID, name: 'Local (no sync)' });
    changed = true;
  }
  // Old installs had a single vaultId (UUID generated on first run). Adopt it as a saved vault.
  if (s.vaultId && s.vaultId !== LOCAL_VAULT_ID && !s.savedVaults.some((v) => v.id === s.vaultId)) {
    s.savedVaults.push({ id: s.vaultId, name: 'Migrated vault' });
    changed = true;
  }
  if (!s.vaultId || !s.savedVaults.some((v) => v.id === s.vaultId)) {
    s.vaultId = LOCAL_VAULT_ID;
    changed = true;
  }
  return changed;
}
