// HTTP client for /auth/* endpoints on the cosync server.
// Uses Obsidian's `requestUrl` so CORS/self-signed cert behavior matches the app.

import { requestUrl } from 'obsidian';

export interface LoginResult {
  ok: true;
  token: string;
  username: string;
  expiresAt: number;
  displayName: string;
  color: string;
}
export interface AuthError {
  ok: false;
  status: number;
  error: string;
}
export type AuthResponse = LoginResult | AuthError;

export interface ProfileResult {
  ok: true;
  displayName: string;
  color: string;
}
export type ProfileResponse = ProfileResult | AuthError;

/** Convert wss:// to https:// (and ws:// to http://) for HTTP auth calls. */
function httpBase(serverUrl: string): string {
  return serverUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/+$/, '');
}

async function postJson(url: string, body: object, headers?: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await requestUrl({
    url,
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify(body),
    headers,
    throw: false,
  });
  let json: any = {};
  try { json = res.json; } catch { /* may be empty */ }
  return { status: res.status, json };
}

async function patchJson(url: string, body: object, headers?: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await requestUrl({
    url,
    method: 'PATCH',
    contentType: 'application/json',
    body: JSON.stringify(body),
    headers,
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
  displayName?: string,
  color?: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const { status, json } = await postJson(`${httpBase(serverUrl)}/auth/register`, {
      username,
      password,
      inviteCode,
      displayName,
      color,
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
      return {
        ok: true,
        token: json.token,
        username: json.username || username,
        expiresAt: json.expiresAt,
        displayName: json.displayName || (json.username || username),
        color: json.color || '#3eb6f7',
      };
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
  } catch { /* ignore, best effort */ }
}

export async function updateProfile(
  serverUrl: string,
  token: string,
  displayName: string,
  color: string,
): Promise<ProfileResponse> {
  if (!token) return { ok: false, status: 401, error: 'not logged in' };
  try {
    const { status, json } = await patchJson(
      `${httpBase(serverUrl)}/auth/profile`,
      { displayName, color },
      { Authorization: `Bearer ${token}` },
    );
    if (status === 200) {
      return { ok: true, displayName: json.displayName, color: json.color };
    }
    return { ok: false, status, error: json?.error || `profile update failed (${status})` };
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.message || String(e) };
  }
}
