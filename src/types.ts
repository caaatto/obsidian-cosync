export interface CoSyncSettings {
  // Connection
  serverUrl: string;       // e.g. wss://obsd.clip.jetzt — auth endpoints use https://...

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
  vaultId: string;
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
  vaultId: '',
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
