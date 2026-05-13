// HTTP client for /auth/* endpoints on the cosync server.
// Uses Obsidian's `requestUrl` so CORS/self-signed cert behavior matches the app.

import { requestUrl } from 'obsidian';

export interface LoginResult {
  ok: true;
  token: string;
  username: string;
  expiresAt: number;
}
export interface AuthError {
  ok: false;
  status: number;
  error: string;
}
export type AuthResponse = LoginResult | AuthError;

/** Convert wss:// → https:// (and ws:// → http://) for HTTP auth calls. */
function httpBase(serverUrl: string): string {
  return serverUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/+$/, '');
}

async function postJson(url: string, body: object): Promise<{ status: number; json: any }> {
  const res = await requestUrl({
    url,
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify(body),
    throw: false,
  });
  let json: any = {};
  try { json = res.json; } catch { /* may be empty */ }
  return { status: res.status, json };
}

export async function register(
  serverUrl: string,
  username: string,
  password: string,
  inviteCode: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const { status, json } = await postJson(`${httpBase(serverUrl)}/auth/register`, {
      username,
      password,
      inviteCode,
    });
    if (status === 201) return { ok: true, status };
    return { ok: false, status, error: json?.error || `register failed (${status})` };
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.message || String(e) };
  }
}

export async function login(serverUrl: string, username: string, password: string): Promise<AuthResponse> {
  try {
    const { status, json } = await postJson(`${httpBase(serverUrl)}/auth/login`, { username, password });
    if (status === 200 && json?.token) {
      return { ok: true, token: json.token, username: json.username || username, expiresAt: json.expiresAt };
    }
    return { ok: false, status, error: json?.error || `login failed (${status})` };
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.message || String(e) };
  }
}

export async function logout(serverUrl: string, token: string): Promise<void> {
  if (!token) return;
  try {
    await postJson(`${httpBase(serverUrl)}/auth/logout`, { token });
  } catch { /* ignore - best effort */ }
}
