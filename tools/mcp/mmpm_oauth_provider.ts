/**
 * Minimal in-memory OAuth2 provider for MMPM MCP server.
 *
 * Implements just enough of the OAuth2 spec for Claude Cowork custom connectors:
 *   - Dynamic Client Registration (RFC 7591)
 *   - Authorization Code flow with PKCE (RFC 7636, S256 only)
 *   - Token refresh
 *   - RFC 9728 metadata discovery
 *
 * Single-tenant: auto-approves all authorization requests (no login page).
 * All state is in-memory — restarts require re-authentication.
 *
 * Zero external dependencies — uses node:crypto only.
 */

import { randomUUID, createHash } from 'crypto';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ClientRecord {
    clientId: string;
    clientSecret: string;
    clientName: string;
    redirectUris: string[];
    createdAt: number;
}

interface AuthCodeRecord {
    clientId: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    redirectUri: string;
    expiresAt: number;
}

interface TokenRecord {
    clientId: string;
    expiresAt: number;
}

// ── Configuration ──────────────────────────────────────────────────────────────

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;          // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;              // 10 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;            // 5 minutes

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Base64url encode a buffer (no padding). */
function base64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Verify PKCE S256: base64url(sha256(verifier)) === challenge */
function verifyPkceS256(verifier: string, challenge: string): boolean {
    const hash = createHash('sha256').update(verifier).digest();
    return base64url(hash) === challenge;
}

// ── Provider ───────────────────────────────────────────────────────────────────

export class OAuthProvider {
    private clients = new Map<string, ClientRecord>();
    private authCodes = new Map<string, AuthCodeRecord>();
    private accessTokens = new Map<string, TokenRecord>();
    private refreshTokens = new Map<string, TokenRecord>();
    private cleanupTimer: ReturnType<typeof setInterval>;

    /** The issuer URL (e.g. https://mmpm.co.nz). Used in metadata. */
    readonly issuer: string;

    constructor(issuer: string) {
        this.issuer = issuer.replace(/\/$/, ''); // strip trailing slash
        this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
        this.cleanupTimer.unref(); // don't block process exit
    }

    // ── Dynamic Client Registration (RFC 7591) ────────────────────────────────

    registerClient(body: {
        client_name?: string;
        redirect_uris?: string[];
    }): {
        client_id: string;
        client_secret: string;
        client_name: string;
        redirect_uris: string[];
    } {
        const clientId = randomUUID();
        const clientSecret = randomUUID();
        const clientName = body.client_name ?? 'unknown';
        const redirectUris = body.redirect_uris ?? [];

        this.clients.set(clientId, {
            clientId,
            clientSecret,
            clientName,
            redirectUris,
            createdAt: Date.now(),
        });

        console.log(`[oauth] Registered client: ${clientName} (${clientId})`);

        return {
            client_id: clientId,
            client_secret: clientSecret,
            client_name: clientName,
            redirect_uris: redirectUris,
        };
    }

    // ── Authorization Code ─────────────────────────────────────────────────────

    createAuthCode(params: {
        clientId: string;
        codeChallenge: string;
        codeChallengeMethod: string;
        redirectUri: string;
    }): string | null {
        const client = this.clients.get(params.clientId);
        if (!client) return null;

        // Validate redirect URI is registered
        if (client.redirectUris.length > 0 && !client.redirectUris.includes(params.redirectUri)) {
            console.log(`[oauth] Redirect URI mismatch: ${params.redirectUri}`);
            return null;
        }

        if (params.codeChallengeMethod !== 'S256') {
            console.log(`[oauth] Unsupported code challenge method: ${params.codeChallengeMethod}`);
            return null;
        }

        const code = randomUUID();
        this.authCodes.set(code, {
            clientId: params.clientId,
            codeChallenge: params.codeChallenge,
            codeChallengeMethod: params.codeChallengeMethod,
            redirectUri: params.redirectUri,
            expiresAt: Date.now() + AUTH_CODE_TTL_MS,
        });

        console.log(`[oauth] Auth code issued for client ${params.clientId}`);
        return code;
    }

    // ── Token Exchange ─────────────────────────────────────────────────────────

    exchangeCode(params: {
        code: string;
        clientId: string;
        clientSecret: string;
        codeVerifier: string;
        redirectUri: string;
    }): {
        access_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
    } | null {
        const record = this.authCodes.get(params.code);
        if (!record) return null;

        // Consume the code (one-time use)
        this.authCodes.delete(params.code);

        // Validate
        if (record.expiresAt < Date.now()) return null;
        if (record.clientId !== params.clientId) return null;
        if (record.redirectUri !== params.redirectUri) return null;

        // Verify client secret
        const client = this.clients.get(params.clientId);
        if (!client || client.clientSecret !== params.clientSecret) return null;

        // Verify PKCE
        if (!verifyPkceS256(params.codeVerifier, record.codeChallenge)) {
            console.log(`[oauth] PKCE verification failed for client ${params.clientId}`);
            return null;
        }

        // Issue tokens
        const accessToken = `mmpm_at_${randomUUID()}`;
        const refreshToken = `mmpm_rt_${randomUUID()}`;

        this.accessTokens.set(accessToken, {
            clientId: params.clientId,
            expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
        });

        this.refreshTokens.set(refreshToken, {
            clientId: params.clientId,
            expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
        });

        console.log(`[oauth] Tokens issued for client ${params.clientId}`);

        return {
            access_token: accessToken,
            refresh_token: refreshToken,
            token_type: 'Bearer',
            expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        };
    }

    // ── Token Refresh ──────────────────────────────────────────────────────────

    refreshAccessToken(params: {
        refreshToken: string;
        clientId: string;
        clientSecret: string;
    }): {
        access_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
    } | null {
        const record = this.refreshTokens.get(params.refreshToken);
        if (!record) return null;
        if (record.expiresAt < Date.now()) {
            this.refreshTokens.delete(params.refreshToken);
            return null;
        }
        if (record.clientId !== params.clientId) return null;

        const client = this.clients.get(params.clientId);
        if (!client || client.clientSecret !== params.clientSecret) return null;

        // Rotate: delete old refresh token, issue new pair
        this.refreshTokens.delete(params.refreshToken);

        const accessToken = `mmpm_at_${randomUUID()}`;
        const newRefreshToken = `mmpm_rt_${randomUUID()}`;

        this.accessTokens.set(accessToken, {
            clientId: params.clientId,
            expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
        });

        this.refreshTokens.set(newRefreshToken, {
            clientId: params.clientId,
            expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
        });

        console.log(`[oauth] Tokens refreshed for client ${params.clientId}`);

        return {
            access_token: accessToken,
            refresh_token: newRefreshToken,
            token_type: 'Bearer',
            expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        };
    }

    // ── Token Validation ───────────────────────────────────────────────────────

    validateAccessToken(token: string): boolean {
        const record = this.accessTokens.get(token);
        if (!record) return false;
        if (record.expiresAt < Date.now()) {
            this.accessTokens.delete(token);
            return false;
        }
        return true;
    }

    // ── Metadata (RFC 9728) ────────────────────────────────────────────────────

    getMetadata(): Record<string, unknown> {
        return {
            issuer: this.issuer,
            authorization_endpoint: `${this.issuer}/oauth/authorize`,
            token_endpoint: `${this.issuer}/oauth/token`,
            registration_endpoint: `${this.issuer}/oauth/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['client_secret_post'],
            code_challenge_methods_supported: ['S256'],
            scopes_supported: [],
        };
    }

    // ── Cleanup expired entries ────────────────────────────────────────────────

    private cleanup(): void {
        const now = Date.now();
        let cleaned = 0;

        for (const [code, rec] of this.authCodes) {
            if (rec.expiresAt < now) { this.authCodes.delete(code); cleaned++; }
        }
        for (const [tok, rec] of this.accessTokens) {
            if (rec.expiresAt < now) { this.accessTokens.delete(tok); cleaned++; }
        }
        for (const [tok, rec] of this.refreshTokens) {
            if (rec.expiresAt < now) { this.refreshTokens.delete(tok); cleaned++; }
        }

        if (cleaned > 0) {
            console.log(`[oauth] Cleaned up ${cleaned} expired entries`);
        }
    }

    destroy(): void {
        clearInterval(this.cleanupTimer);
    }
}
