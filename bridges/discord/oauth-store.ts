/**
 * OAuth Token Store
 *
 * CRUD + AES-256-GCM encryption for refresh tokens + auto-refresh for
 * Microsoft (MSAL) and LinkedIn (direct HTTP) OAuth providers.
 *
 * Deterministic infrastructure — no LLM involved.
 */

import { getDb } from "./db.js";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

export type OAuthProvider = "microsoft" | "linkedin" | "linkedin-community" | "gmail";

export interface TokenRecord {
  provider: OAuthProvider;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: string; // ISO datetime
  scopes: string;
  extra: Record<string, any> | null;
  updatedAt: string;
}

// ─── Encryption ─────────────────────────────────────────────────────

const ENCRYPTION_KEY = process.env.OAUTH_ENCRYPTION_KEY || "";

function getKey(): Buffer | null {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) return null;
  return Buffer.from(ENCRYPTION_KEY, "hex");
}

function encrypt(plaintext: string): string {
  const key = getKey();
  if (!key) {
    if (ENCRYPTION_KEY === "") {
      console.error("[oauth-store] WARNING: OAUTH_ENCRYPTION_KEY not set — storing refresh token in plaintext (dev mode)");
    }
    return plaintext;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all hex)
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(ciphertext: string): string {
  const key = getKey();
  if (!key) return ciphertext; // Plaintext fallback
  const parts = ciphertext.split(":");
  if (parts.length !== 3) return ciphertext; // Not encrypted (legacy/dev)
  const [ivHex, tagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// ─── Token CRUD ─────────────────────────────────────────────────────

export function getTokens(provider: OAuthProvider): TokenRecord | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM oauth_tokens WHERE provider = ?")
    .get(provider) as any;
  if (!row) return null;
  return {
    provider: row.provider,
    accessToken: row.access_token,
    refreshToken: decrypt(row.refresh_token),
    tokenType: row.token_type,
    expiresAt: row.expires_at,
    scopes: row.scopes,
    extra: row.extra ? JSON.parse(row.extra) : null,
    updatedAt: row.updated_at,
  };
}

export function saveTokens(
  provider: OAuthProvider,
  tokens: {
    accessToken: string;
    refreshToken: string;
    tokenType?: string;
    expiresAt: string;
    scopes: string;
    extra?: Record<string, any>;
  }
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO oauth_tokens (provider, access_token, refresh_token, token_type, expires_at, scopes, extra, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      token_type = excluded.token_type,
      expires_at = excluded.expires_at,
      scopes = excluded.scopes,
      extra = excluded.extra,
      updated_at = datetime('now')
  `).run(
    provider,
    tokens.accessToken,
    encrypt(tokens.refreshToken),
    tokens.tokenType || "Bearer",
    tokens.expiresAt,
    tokens.scopes,
    tokens.extra ? JSON.stringify(tokens.extra) : null
  );
}

export function isExpired(provider: OAuthProvider): boolean {
  const record = getTokens(provider);
  if (!record) return true;
  const expiresAt = new Date(record.expiresAt).getTime();
  const buffer = 5 * 60 * 1000; // 5 minutes
  return Date.now() >= expiresAt - buffer;
}

// ─── Token Refresh ──────────────────────────────────────────────────

export async function refreshMicrosoftToken(): Promise<TokenRecord> {
  const record = getTokens("microsoft");
  if (!record) throw new Error("No Microsoft tokens stored — run oauth-setup.ts microsoft");

  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("MS_CLIENT_ID and MS_CLIENT_SECRET must be set");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: record.refreshToken,
    grant_type: "refresh_token",
    scope: record.scopes,
  });

  const res = await fetch("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Microsoft token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
    scope: string;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  const newTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || record.refreshToken,
    tokenType: data.token_type,
    expiresAt,
    scopes: data.scope || record.scopes,
    extra: record.extra || undefined,
  };

  saveTokens("microsoft", newTokens);
  return getTokens("microsoft")!;
}

export async function refreshLinkedInToken(): Promise<TokenRecord> {
  const record = getTokens("linkedin");
  if (!record) throw new Error("No LinkedIn tokens stored — run oauth-setup.ts linkedin");

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET must be set");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: record.refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LinkedIn token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    refresh_token_expires_in?: number;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  const newTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || record.refreshToken,
    expiresAt,
    scopes: record.scopes,
    extra: record.extra || undefined,
  };

  saveTokens("linkedin", newTokens);
  return getTokens("linkedin")!;
}

export async function refreshLinkedInCommunityToken(): Promise<TokenRecord> {
  const record = getTokens("linkedin-community");
  if (!record) throw new Error("No LinkedIn Community tokens stored — run oauth-setup.ts linkedin-community");

  const clientId = process.env.LINKEDIN_COMMUNITY_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_COMMUNITY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("LINKEDIN_COMMUNITY_CLIENT_ID and LINKEDIN_COMMUNITY_CLIENT_SECRET must be set");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: record.refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LinkedIn Community token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    refresh_token_expires_in?: number;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  const newTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || record.refreshToken,
    expiresAt,
    scopes: record.scopes,
    extra: record.extra || undefined,
  };

  saveTokens("linkedin-community", newTokens);
  return getTokens("linkedin-community")!;
}

export async function refreshGmailToken(): Promise<TokenRecord> {
  const record = getTokens("gmail");
  if (!record) throw new Error("No Gmail tokens stored — run: npx tsx oauth-setup.ts gmail");

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: record.refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  const newTokens = {
    accessToken: data.access_token,
    refreshToken: record.refreshToken, // Google doesn't return a new refresh token on refresh
    tokenType: data.token_type,
    expiresAt,
    scopes: data.scope || record.scopes,
  };

  saveTokens("gmail", newTokens);
  return getTokens("gmail")!;
}

export async function ensureFreshToken(provider: OAuthProvider): Promise<string> {
  if (!isExpired(provider)) {
    return getTokens(provider)!.accessToken;
  }

  let refreshed: TokenRecord;
  if (provider === "microsoft") {
    refreshed = await refreshMicrosoftToken();
  } else if (provider === "linkedin-community") {
    refreshed = await refreshLinkedInCommunityToken();
  } else if (provider === "gmail") {
    refreshed = await refreshGmailToken();
  } else {
    refreshed = await refreshLinkedInToken();
  }

  return refreshed.accessToken;
}
