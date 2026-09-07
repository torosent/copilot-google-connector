import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { ConnectorError } from "../core/errors.js";
import { GOOGLE_AUTH_URL, GOOGLE_CERTS_URL, GOOGLE_SCOPES, GOOGLE_TOKEN_URL } from "./constants.js";
import { fetchJson, type Fetch } from "./http.js";

export interface DesktopClient { clientId: string; clientSecret: string }
export interface Identity { subject: string; email: string }
export interface Tokens {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  scopes?: string[];
}
export interface OAuthGrant extends Tokens { identity: Identity; scopes: string[] }
export interface OAuthProvider {
  authorize(client: DesktopClient): Promise<OAuthGrant>;
  refresh(client: DesktopClient, refreshToken: string): Promise<Tokens>;
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function equalSecret(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

export async function openBrowser(url: string): Promise<void> {
  const parsed = new URL(url);
  const allowedParameters = new Set(["client_id", "redirect_uri", "response_type", "scope", "state", "nonce", "code_challenge", "code_challenge_method", "access_type", "prompt"]);
  if (parsed.origin + parsed.pathname !== GOOGLE_AUTH_URL || parsed.hash || parsed.username || parsed.password
    || [...parsed.searchParams.keys()].some((key) => !allowedParameters.has(key))) {
    throw new ConnectorError("browser_url_invalid", "Refusing to open a non-Google OAuth authorization URL.");
  }
  const command = process.platform === "darwin" ? "/usr/bin/open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      reject(new ConnectorError("browser_open_failed", "The system browser did not open in time. Check your default browser and retry the account command."));
    }, 10_000);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new ConnectorError("browser_open_failed", "Cannot launch the system browser. Configure a default browser and retry the account command."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new ConnectorError("browser_open_failed", "Cannot launch the system browser. Configure a default browser and retry the account command."));
    });
  });
}

export interface AuthorizationCode { code: string; redirectUri: string; verifier: string; nonce: string }

export async function receiveAuthorizationCode(
  clientId: string,
  options: { open?: (url: string) => Promise<void>; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<AuthorizationCode> {
  const { verifier, challenge } = createPkce();
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  let host = "";
  let redirectUri = "";
  let settled = false;
  let resolveCode!: (value: AuthorizationCode) => void;
  let rejectCode!: (error: ConnectorError) => void;
  const received = new Promise<AuthorizationCode>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // A browser can fail before the code promise is awaited.
  void received.catch(() => undefined);
  const fail = (error: ConnectorError) => {
    if (!settled) { settled = true; rejectCode(error); }
  };
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Connection", "close");
    const invalid = (code: string, message: string) => {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Authorization callback rejected. Return to the connector.");
      fail(new ConnectorError(code, message));
    };
    if (settled) { response.writeHead(409); response.end(); return; }
    const hostCount = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === "host").length;
    if (request.method !== "GET" || hostCount !== 1 || request.headers.host !== host || !request.url || request.url.length > 16_384 || !request.url.startsWith("/oauth2/callback?")) {
      invalid("oauth_callback_invalid", "The OAuth callback used an invalid method, host, or path.");
      return;
    }
    const url = new URL(request.url, `http://${host}`);
    if (url.pathname !== "/oauth2/callback" || url.hash || [...new Set(url.searchParams.keys())].some((key) => url.searchParams.getAll(key).length !== 1)) {
      invalid("oauth_callback_invalid", "The OAuth callback contained malformed or duplicate parameters.");
      return;
    }
    const returnedState = url.searchParams.get("state");
    if (!returnedState || !equalSecret(returnedState, state)) {
      invalid("oauth_state_mismatch", "OAuth state validation failed. Start a new account authorization.");
      return;
    }
    const code = url.searchParams.get("code");
    const denial = url.searchParams.get("error");
    if (url.searchParams.has("code") === url.searchParams.has("error")
      || (url.searchParams.has("code") && (!code || code.length > 4096 || /[\u0000-\u0020\u007f]/.test(code)))
      || (url.searchParams.has("error") && (!denial || !/^[a-z_]{1,64}$/.test(denial)))) {
      invalid("oauth_callback_invalid", "The OAuth callback did not contain exactly one valid authorization result.");
      return;
    }
    if (denial) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Authorization was not granted. Return to the connector.");
      fail(new ConnectorError("oauth_consent_denied", "Google authorization was denied or cancelled. Run the account command again when ready."));
      return;
    }
    settled = true;
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Authorization received. You can close this tab and return to the connector.");
    resolveCode({ code: code!, redirectUri, verifier, nonce });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 32;
  const cancel = () => fail(new ConnectorError("oauth_cancelled", "Google authorization was cancelled."));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => reject(new ConnectorError("oauth_listener_failed", "Cannot start the private loopback OAuth listener.")));
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new ConnectorError("oauth_listener_failed", "Cannot start the private loopback OAuth listener.");
    host = `127.0.0.1:${address.port}`;
    redirectUri = `http://${host}/oauth2/callback`;
    const authorization = new URL(GOOGLE_AUTH_URL);
    authorization.search = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: "code",
      scope: GOOGLE_SCOPES.join(" "), state, nonce,
      code_challenge: challenge, code_challenge_method: "S256",
      access_type: "offline", prompt: "consent select_account",
    }).toString();
    timer = setTimeout(() => fail(new ConnectorError("oauth_timeout", "Google authorization timed out. Run the account command again.")), options.timeoutMs ?? 180_000);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    if (!settled) {
      const opened = (options.open ?? openBrowser)(authorization.toString()).catch(() => {
        fail(new ConnectorError("browser_open_failed", "Cannot open the system browser. Configure a default browser and retry the account command."));
      });
      // The overall deadline also bounds a stuck platform opener.
      await Promise.race([opened, received]);
    }
    return await received;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("oauth_failed", "Google authorization could not complete.");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const tokenSchema = z.object({
  access_token: z.string().min(1).max(32_768).regex(/^[\x21-\x7e]+$/),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token: z.string().min(1).max(2048).regex(/^[\x21-\x7e]+$/).optional(),
  id_token: z.string().min(1).max(32_768).optional(),
  scope: z.string().max(16_384).optional(),
});

export function parseScopes(scope: string): string[] {
  const scopes = scope.trim().split(/\s+/);
  if (scopes.length > 100 || scopes.some((entry) => !entry || entry.length > 256 || !/^[\x21-\x7e]+$/.test(entry))) {
    throw new ConnectorError("oauth_scopes_invalid", "Google returned an invalid granted-scope list.");
  }
  return [...new Set(scopes)];
}

export class GoogleOAuth implements OAuthProvider {
  private readonly fetcher: Fetch;
  private readonly now: () => number;
  constructor(private readonly options: {
    fetch?: Fetch;
    now?: () => number;
    open?: (url: string) => Promise<void>;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  private async token(parameters: Record<string, string>): Promise<z.infer<typeof tokenSchema>> {
    const response = await fetchJson(this.fetcher, GOOGLE_TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters).toString(),
    }, { maxBytes: 128 * 1024 });
    if (response.status !== 200) {
      const providerCode = z.object({ error: z.string() }).safeParse(response.body);
      if (providerCode.success && providerCode.data.error === "invalid_grant") {
        throw new ConnectorError("reauth_required", "Google rejected or revoked this grant. Run accounts reauth for this account.");
      }
      if (providerCode.success && ["invalid_client", "unauthorized_client"].includes(providerCode.data.error)) {
        throw new ConnectorError("oauth_client_rejected", "Google rejected the imported Desktop OAuth client. Check its Google Cloud configuration.");
      }
      throw new ConnectorError("oauth_token_failed", "Google could not issue credentials. Check consent and OAuth client setup; no automatic retry was attempted.", false, { httpStatus: response.status });
    }
    const result = tokenSchema.safeParse(response.body);
    if (!result.success) throw new ConnectorError("oauth_token_invalid", "Google returned an incomplete or invalid token response.");
    return result.data;
  }

  async verifyIdentity(idToken: string, clientId: string, nonce: string): Promise<Identity> {
    try {
      const encodedHeader = idToken.split(".")[0];
      if (!encodedHeader || encodedHeader.length > 4096) throw new Error();
      const header = z.object({ alg: z.literal("RS256"), kid: z.string().min(1).max(256) }).parse(JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")));
      const certificates = await fetchJson(this.fetcher, GOOGLE_CERTS_URL, { method: "GET" }, { maxBytes: 128 * 1024 });
      if (certificates.status !== 200) throw new Error();
      const certs = z.record(z.string().max(256), z.string().max(16_384)).parse(certificates.body);
      if (Object.keys(certs).length > 20 || !Object.hasOwn(certs, header.kid)) throw new Error();
      const ticket = await new OAuth2Client().verifySignedJwtWithCertsAsync(idToken, certs, clientId, ["accounts.google.com", "https://accounts.google.com"], 86_400);
      const claims = z.object({
        sub: z.string().min(1).max(255).regex(/^[\x21-\x7e]+$/),
        email: z.email().max(320),
        email_verified: z.literal(true),
        nonce: z.string().min(1).max(256),
        aud: z.literal(clientId),
        azp: z.literal(clientId).optional(),
        iss: z.enum(["accounts.google.com", "https://accounts.google.com"]),
        exp: z.number().int(),
        iat: z.number().int(),
      }).parse(ticket.getPayload());
      if (claims.exp * 1000 <= this.now() || claims.iat * 1000 > this.now() + 60_000 || !equalSecret(claims.nonce, nonce)) throw new Error();
      return { subject: claims.sub, email: claims.email };
    } catch {
      throw new ConnectorError("oauth_identity_invalid", "Google identity verification failed. No account credentials were changed.");
    }
  }

  async authorize(client: DesktopClient): Promise<OAuthGrant> {
    const result = await receiveAuthorizationCode(client.clientId, this.options);
    const token = await this.token({
      client_id: client.clientId, client_secret: client.clientSecret,
      grant_type: "authorization_code", code: result.code,
      redirect_uri: result.redirectUri, code_verifier: result.verifier,
    });
    if (!token.id_token) throw new ConnectorError("oauth_identity_missing", "Google did not return an identity token. Grant the openid and email scopes.");
    if (!token.scope) throw new ConnectorError("oauth_scopes_missing", "Google did not report granted scopes. Reauthorize this account.");
    const identity = await this.verifyIdentity(token.id_token, client.clientId, result.nonce);
    return {
      accessToken: token.access_token, expiresAt: this.now() + token.expires_in * 1000,
      refreshToken: token.refresh_token, scopes: parseScopes(token.scope), identity,
    };
  }

  async refresh(client: DesktopClient, refreshToken: string): Promise<Tokens> {
    const token = await this.token({
      client_id: client.clientId, client_secret: client.clientSecret,
      grant_type: "refresh_token", refresh_token: refreshToken,
    });
    return {
      accessToken: token.access_token, expiresAt: this.now() + token.expires_in * 1000,
      refreshToken: token.refresh_token, scopes: token.scope === undefined ? undefined : parseScopes(token.scope),
    };
  }
}
