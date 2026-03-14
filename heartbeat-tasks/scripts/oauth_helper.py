"""
OAuth Helper — shared Python module for heartbeat scripts.

Reads tokens from SQLite (harness.db), handles refresh via requests.
Self-contained — no dependency on TypeScript modules.

Usage:
    from oauth_helper import get_access_token
    token = get_access_token("microsoft")
"""

import os
import sys
import json
import sqlite3
import time
import urllib.request
import urllib.parse
import urllib.error

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
DB_PATH = os.path.join(HARNESS_ROOT, "bridges", "discord", "harness.db")


def _get_db():
    """Open read-write connection to harness.db."""
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"Database not found: {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _decrypt_refresh_token(encrypted):
    """
    Decrypt AES-256-GCM encrypted refresh token.
    Falls back to plaintext if OAUTH_ENCRYPTION_KEY is not set or token is not encrypted.
    """
    key_hex = os.environ.get("OAUTH_ENCRYPTION_KEY", "")
    if not key_hex or len(key_hex) != 64:
        return encrypted  # Plaintext mode

    parts = encrypted.split(":")
    if len(parts) != 3:
        return encrypted  # Not encrypted (legacy/dev)

    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        iv = bytes.fromhex(parts[0])
        tag = bytes.fromhex(parts[1])
        ciphertext = bytes.fromhex(parts[2])
        key = bytes.fromhex(key_hex)
        aesgcm = AESGCM(key)
        # GCM: ciphertext + tag concatenated
        plaintext = aesgcm.decrypt(iv, ciphertext + tag, None)
        return plaintext.decode("utf-8")
    except ImportError:
        # cryptography not installed — try without decryption
        print("WARNING: cryptography package not installed, cannot decrypt refresh token", file=sys.stderr)
        return encrypted
    except Exception as e:
        print(f"WARNING: Failed to decrypt refresh token: {e}", file=sys.stderr)
        return encrypted


def get_tokens(provider):
    """Get stored tokens for a provider. Returns dict or None."""
    conn = _get_db()
    try:
        row = conn.execute(
            "SELECT * FROM oauth_tokens WHERE provider = ?", (provider,)
        ).fetchone()
        if not row:
            return None
        return {
            "provider": row["provider"],
            "access_token": row["access_token"],
            "refresh_token": _decrypt_refresh_token(row["refresh_token"]),
            "token_type": row["token_type"],
            "expires_at": row["expires_at"],
            "scopes": row["scopes"],
            "extra": json.loads(row["extra"]) if row["extra"] else None,
        }
    finally:
        conn.close()


def _encrypt_refresh_token(plaintext):
    """
    Encrypt refresh token with AES-256-GCM to match TypeScript oauth-store format.
    Falls back to plaintext if OAUTH_ENCRYPTION_KEY is not set.
    """
    key_hex = os.environ.get("OAUTH_ENCRYPTION_KEY", "")
    if not key_hex or len(key_hex) != 64:
        return plaintext  # No encryption key — store as plaintext

    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        key = bytes.fromhex(key_hex)
        aesgcm = AESGCM(key)
        iv = os.urandom(12)  # 96-bit nonce
        ciphertext_and_tag = aesgcm.encrypt(iv, plaintext.encode("utf-8"), None)
        # Split: ciphertext is all but last 16 bytes, tag is last 16 bytes
        ciphertext = ciphertext_and_tag[:-16]
        tag = ciphertext_and_tag[-16:]
        return f"{iv.hex()}:{tag.hex()}:{ciphertext.hex()}"
    except ImportError:
        print("WARNING: cryptography package not installed, storing refresh token as plaintext", file=sys.stderr)
        return plaintext
    except Exception as e:
        print(f"WARNING: Failed to encrypt refresh token: {e}", file=sys.stderr)
        return plaintext


def _save_tokens(provider, tokens):
    """Save tokens back to SQLite with encrypted refresh token."""
    conn = _get_db()
    try:
        # Re-encrypt the refresh token so TypeScript side can read it
        encrypted_refresh = _encrypt_refresh_token(tokens["refresh_token"])
        conn.execute(
            """INSERT INTO oauth_tokens (provider, access_token, refresh_token, token_type, expires_at, scopes, extra, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(provider) DO UPDATE SET
                 access_token = excluded.access_token,
                 refresh_token = excluded.refresh_token,
                 token_type = excluded.token_type,
                 expires_at = excluded.expires_at,
                 updated_at = datetime('now')""",
            (
                provider,
                tokens["access_token"],
                encrypted_refresh,
                tokens.get("token_type", "Bearer"),
                tokens["expires_at"],
                tokens["scopes"],
                json.dumps(tokens["extra"]) if tokens.get("extra") else None,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def is_expired(tokens):
    """Check if token is expired (with 5-minute buffer)."""
    from datetime import datetime
    try:
        expires = datetime.fromisoformat(tokens["expires_at"].replace("Z", "+00:00"))
        now = datetime.now(expires.tzinfo) if expires.tzinfo else datetime.now()
        buffer = 5 * 60  # 5 minutes
        return (expires.timestamp() - buffer) <= now.timestamp()
    except Exception:
        return True


def _refresh_microsoft(tokens):
    """Refresh Microsoft token via direct HTTP."""
    client_id = os.environ.get("MS_CLIENT_ID", "")
    client_secret = os.environ.get("MS_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        raise RuntimeError("MS_CLIENT_ID and MS_CLIENT_SECRET must be set")

    data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": tokens["refresh_token"],
        "grant_type": "refresh_token",
        "scope": tokens["scopes"],
    }).encode()

    req = urllib.request.Request(
        "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f"Microsoft refresh failed ({e.code}): {body}")

    from datetime import datetime, timedelta
    expires_at = (datetime.now() + timedelta(seconds=result["expires_in"])).isoformat()

    new_tokens = {
        **tokens,
        "access_token": result["access_token"],
        "refresh_token": result.get("refresh_token", tokens["refresh_token"]),
        "expires_at": expires_at,
    }
    _save_tokens("microsoft", new_tokens)
    return new_tokens


def _refresh_linkedin(tokens):
    """Refresh LinkedIn token via direct HTTP."""
    client_id = os.environ.get("LINKEDIN_CLIENT_ID", "")
    client_secret = os.environ.get("LINKEDIN_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        raise RuntimeError("LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET must be set")

    data = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": tokens["refresh_token"],
        "client_id": client_id,
        "client_secret": client_secret,
    }).encode()

    req = urllib.request.Request(
        "https://www.linkedin.com/oauth/v2/accessToken",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f"LinkedIn refresh failed ({e.code}): {body}")

    from datetime import datetime, timedelta
    expires_at = (datetime.now() + timedelta(seconds=result["expires_in"])).isoformat()

    new_tokens = {
        **tokens,
        "access_token": result["access_token"],
        "refresh_token": result.get("refresh_token", tokens["refresh_token"]),
        "expires_at": expires_at,
    }
    _save_tokens("linkedin", new_tokens)
    return new_tokens


def get_access_token(provider):
    """
    Get a valid access token for the given provider.
    Automatically refreshes if expired.
    """
    tokens = get_tokens(provider)
    if not tokens:
        raise RuntimeError(f"No {provider} tokens stored — run: npx tsx oauth-setup.ts {provider}")

    if not is_expired(tokens):
        return tokens["access_token"]

    print(f"[oauth_helper] Refreshing {provider} token...", file=sys.stderr)
    if provider == "microsoft":
        tokens = _refresh_microsoft(tokens)
    elif provider == "linkedin":
        tokens = _refresh_linkedin(tokens)
    else:
        raise ValueError(f"Unknown provider: {provider}")

    return tokens["access_token"]
