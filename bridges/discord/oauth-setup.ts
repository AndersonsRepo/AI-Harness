#!/usr/bin/env npx tsx
/**
 * One-time OAuth Setup
 *
 * Usage:
 *   HARNESS_ROOT=... npx tsx oauth-setup.ts microsoft
 *   HARNESS_ROOT=... npx tsx oauth-setup.ts linkedin
 *
 * Starts a temporary HTTP server on localhost:3847, opens the browser to the
 * OAuth authorization URL, captures the callback, exchanges for tokens, and
 * saves them to SQLite via oauth-store.ts.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { exec } from "child_process";
import { saveTokens, type OAuthProvider } from "./oauth-store.js";

const PORT = 3847;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

// ─── Microsoft ──────────────────────────────────────────────────────

const MS_SCOPES = "Mail.Read Calendars.Read User.Read offline_access";

function getMicrosoftAuthUrl(): string {
  const clientId = process.env.MS_CLIENT_ID;
  if (!clientId) throw new Error("MS_CLIENT_ID env var required");

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: MS_SCOPES,
    response_mode: "query",
    prompt: "consent",
  });

  return `https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?${params}`;
}

async function exchangeMicrosoftCode(code: string): Promise<void> {
  const clientId = process.env.MS_CLIENT_ID!;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!clientSecret) throw new Error("MS_CLIENT_SECRET env var required");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
    scope: MS_SCOPES,
  });

  const res = await fetch("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Microsoft token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
  };

  saveTokens("microsoft", {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: data.token_type,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    scopes: data.scope,
  });

  console.log("Microsoft tokens saved successfully.");
}

// ─── LinkedIn ───────────────────────────────────────────────────────

const LINKEDIN_SCOPES = "w_member_social openid profile";

function getLinkedInAuthUrl(): string {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  if (!clientId) throw new Error("LINKEDIN_CLIENT_ID env var required");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: LINKEDIN_SCOPES,
    state: "harness-oauth",
  });

  return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
}

async function exchangeLinkedInCode(code: string): Promise<void> {
  const clientId = process.env.LINKEDIN_CLIENT_ID!;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  if (!clientSecret) throw new Error("LINKEDIN_CLIENT_SECRET env var required");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LinkedIn token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    refresh_token_expires_in?: number;
  };

  // Fetch person URN via userinfo (requires openid scope)
  let extra: Record<string, any> = {};
  try {
    const profileRes = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (profileRes.ok) {
      const profile = (await profileRes.json()) as { sub: string; name?: string; email?: string };
      extra = { personUrn: `urn:li:person:${profile.sub}`, name: profile.name, email: profile.email };
      console.log(`LinkedIn profile: ${profile.name} (${profile.sub})`);
    }
  } catch (err: any) {
    console.error(`Warning: Could not fetch LinkedIn profile: ${err.message}`);
  }

  saveTokens("linkedin", {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "none",
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    scopes: LINKEDIN_SCOPES,
    extra,
  });

  console.log("LinkedIn tokens saved successfully.");
}

// ─── Server ─────────────────────────────────────────────────────────

async function run(provider: OAuthProvider): Promise<void> {
  const authUrl = provider === "microsoft" ? getMicrosoftAuthUrl() : getLinkedInAuthUrl();

  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://localhost:${PORT}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400);
        res.end(`OAuth error: ${error} — ${url.searchParams.get("error_description") || ""}`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end("Missing authorization code");
        server.close();
        reject(new Error("Missing authorization code"));
        return;
      }

      try {
        if (provider === "microsoft") {
          await exchangeMicrosoftCode(code);
        } else {
          await exchangeLinkedInCode(code);
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html><body style="font-family:system-ui;text-align:center;padding:60px">
            <h1>Tokens saved for ${provider}</h1>
            <p>You can close this window.</p>
          </body></html>
        `);

        server.close();
        resolve();
      } catch (err: any) {
        res.writeHead(500);
        res.end(`Token exchange failed: ${err.message}`);
        server.close();
        reject(err);
      }
    });

    server.listen(PORT, () => {
      console.log(`\nListening on http://localhost:${PORT}/callback`);
      console.log(`Opening browser for ${provider} OAuth...\n`);
      // Open browser (macOS)
      exec(`open "${authUrl}"`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out after 5 minutes"));
    }, 5 * 60 * 1000);
  });
}

// ─── CLI ────────────────────────────────────────────────────────────

const provider = process.argv[2] as OAuthProvider;
if (provider !== "microsoft" && provider !== "linkedin") {
  console.error("Usage: npx tsx oauth-setup.ts <microsoft|linkedin>");
  process.exit(1);
}

run(provider)
  .then(() => {
    console.log(`\nDone! ${provider} OAuth setup complete.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
