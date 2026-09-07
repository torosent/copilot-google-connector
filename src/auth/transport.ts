import { ConnectorError } from "../core/errors.js";
import type { GoogleRequest, GoogleTransport } from "../core/types.js";
import type { AccountManager } from "./accounts.js";
import { MAX_RESPONSE_BYTES } from "./constants.js";
import { fetchJson, retryDelay, sleep, type Fetch } from "./http.js";

interface Route { path: string; read: boolean; scopes: string[] }
const PREFIX = "https://www.googleapis.com/auth/";

function forbidden(): ConnectorError {
  return new ConnectorError("google_request_forbidden", "This Google endpoint, method, or request option is not supported by the connector.", false, { outcomeUnknown: false });
}

function pathParts(path: string): string[] {
  if (typeof path !== "string" || path.length > 8192 || !path.startsWith("/") || path.startsWith("//") || /[?#\\\u0000-\u0020\u007f]/.test(path)) throw forbidden();
  try {
    const parts = path.slice(1).split("/").map((part) => decodeURIComponent(part));
    if (parts.some((part) => !part || part === "." || part === ".." || part.length > 2048 || /[/\\%\u0000-\u001f\u007f]/.test(part))) throw forbidden();
    return parts;
  } catch { throw forbidden(); }
}

export function validateGoogleRequest(request: GoogleRequest): Route {
  if (!request || !["gmail", "calendar"].includes(request.api) || !["GET", "POST", "PATCH", "DELETE"].includes(request.method)) throw forbidden();
  const p = pathParts(request.path);
  const path = "/" + p.map(encodeURIComponent).join("/");
  const isGet = request.method === "GET";
  if (request.api === "gmail") {
    if (p[0] !== "users" || p[1] !== "me") throw forbidden();
    if (isGet && (
      ((p[2] === "messages" || p[2] === "threads") && (p.length === 3 || p.length === 4))
      || (p[2] === "messages" && p[4] === "attachments" && p.length === 6)
    )) return { path, read: true, scopes: [`${PREFIX}gmail.readonly`] };
    if (request.method === "POST" && p.length === 3 && p[2] === "drafts") {
      return { path, read: false, scopes: [`${PREFIX}gmail.compose`] };
    }
  } else {
    if (isGet && p[0] === "users" && p[1] === "me" && p[2] === "calendarList" && (p.length === 3 || p.length === 4)) {
      return { path, read: true, scopes: [`${PREFIX}calendar.calendarlist.readonly`] };
    }
    if (p.length === 1 && p[0] === "freeBusy" && request.method === "POST") {
      return { path, read: true, scopes: [`${PREFIX}calendar.events.freebusy`] };
    }
    if (p[0] === "calendars" && p[2] === "events") {
      if (isGet && (p.length === 3 || p.length === 4 || (p.length === 5 && p[4] === "instances"))) {
        return { path, read: true, scopes: [`${PREFIX}calendar.events`] };
      }
      if ((request.method === "POST" && p.length === 3) || (["PATCH", "DELETE"].includes(request.method) && p.length === 4)) {
        return { path, read: false, scopes: [`${PREFIX}calendar.events`] };
      }
    }
  }
  throw forbidden();
}

const KNOWN_REASONS: Record<string, string> = {
  accessNotConfigured: "api_disabled",
  SERVICE_DISABLED: "api_disabled",
  insufficientPermissions: "insufficient_permissions",
  ACCESS_TOKEN_SCOPE_INSUFFICIENT: "insufficient_permissions",
  rateLimitExceeded: "rate_limit",
  userRateLimitExceeded: "rate_limit",
  quotaExceeded: "quota_exceeded",
  dailyLimitExceeded: "quota_exceeded",
  notFound: "not_found",
  forbidden: "forbidden",
  authError: "unauthorized",
  conditionNotMet: "precondition_failed",
};

function providerReason(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("error" in body) || !body.error || typeof body.error !== "object") return undefined;
  const error = body.error as { errors?: unknown; details?: unknown };
  for (const group of [error.errors, error.details]) {
    if (!Array.isArray(group)) continue;
    for (const item of group.slice(0, 20)) {
      if (item && typeof item === "object" && "reason" in item && typeof item.reason === "string" && Object.hasOwn(KNOWN_REASONS, item.reason)) {
        return KNOWN_REASONS[item.reason];
      }
    }
  }
  return undefined;
}

export class AuthenticatedGoogleTransport implements GoogleTransport {
  private readonly fetcher: Fetch;
  private readonly wait: (milliseconds: number) => Promise<void>;
  constructor(
    private readonly accounts: AccountManager,
    private readonly options: { fetch?: Fetch; sleep?: (milliseconds: number) => Promise<void>; timeoutMs?: number } = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.wait = options.sleep ?? sleep;
  }

  async request<T>(accountId: string, request: GoogleRequest): Promise<T> {
    const route = validateGoogleRequest(request);
    const method = request.method;
    const maxBytes = request.maxBytes ?? MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BYTES
      || (request.readOnly !== undefined && typeof request.readOnly !== "boolean")
      || (request.expectedGeneration !== undefined && (typeof request.expectedGeneration !== "string" || request.expectedGeneration.length > 128))) throw forbidden();
    const url = new URL((request.api === "gmail" ? "https://gmail.googleapis.com/gmail/v1" : "https://www.googleapis.com/calendar/v3") + route.path);
    const forbiddenQueryKeys = new Set(["access_token", "oauth_token", "key", "callback", "alt", "$.xgafv", "uploadType", "upload_protocol"]);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value === undefined) continue;
      if (!/^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(key) || forbiddenQueryKeys.has(key)
        || !["string", "number", "boolean"].includes(typeof value)
        || (typeof value === "number" && !Number.isFinite(value)) || String(value).length > 16_384) throw forbidden();
      url.searchParams.set(key, String(value));
    }
    if (url.toString().length > 32_768) throw forbidden();
    const headers = new Headers({ Accept: "application/json" });
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      if (!["if-match", "if-none-match"].includes(key.toLowerCase()) || typeof value !== "string" || value.length > 1024
        || /[\u0000-\u001f\u007f]/.test(value) || headers.has(key)) throw forbidden();
      headers.set(key, value);
    }
    let body: string | undefined;
    if (request.body !== undefined) {
      if (method === "GET" || method === "DELETE") throw forbidden();
      try { body = JSON.stringify(request.body); } catch { throw forbidden(); }
      if (body === undefined || Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
        throw new ConnectorError("request_body_too_large", "The Google request body exceeds the maximum encoded byte limit.", false, { outcomeUnknown: false });
      }
      headers.set("Content-Type", "application/json");
    }
    const eligibleForRetry = route.read && request.readOnly === true;
    return this.accounts.withAccess(accountId, request.expectedGeneration, async (account, accessToken) => {
      const missingScopes = route.scopes.filter((scope) => !account.scopes.includes(scope));
      if (missingScopes.length > 0) {
        throw new ConnectorError("missing_scopes", "This account has not granted the required Google scopes. Run accounts reauth to consent.", false, { accountId, missingScopes, outcomeUnknown: false });
      }
      headers.set("Authorization", `Bearer ${accessToken}`);
      const attempts = eligibleForRetry ? 3 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        let response;
        try {
          response = await fetchJson(this.fetcher, url.toString(), { method, headers, body }, {
            maxBytes, timeoutMs: this.options.timeoutMs, mutation: !route.read,
          });
        } catch (error) {
          if (error instanceof ConnectorError && error.retryable && attempt + 1 < attempts) {
            await this.wait(250 * 2 ** attempt);
            continue;
          }
          throw error;
        }
        if (response.status >= 200 && response.status < 300) return response.body as T;
        const reason = providerReason(response.body);
        const retryableStatus = response.status === 429 || response.status >= 500 || (response.status === 403 && reason === "rate_limit");
        if (retryableStatus && attempt + 1 < attempts) {
          await this.wait(retryDelay(response.headers, attempt));
          continue;
        }
        const outcomeUnknown = !route.read && (response.status === 408 || response.status >= 500 || response.status < 400);
        const message = response.status === 401 ? "Google rejected this account's authorization. Run accounts reauth."
          : response.status === 412 ? "Google rejected a stale resource version. Read the resource again before preparing a new change."
          : reason === "api_disabled" ? "This Google API is disabled for the imported OAuth project. Enable it in Google Cloud."
          : reason === "insufficient_permissions" ? "Google denied the required permission. Check the account's granted scopes and resource access."
          : outcomeUnknown ? "Google did not confirm the result after a mutation was dispatched. Its outcome is unknown; do not automatically repeat it."
          : "Google rejected the request.";
        throw new ConnectorError(
          response.status === 401 ? "reauth_required" : response.status === 412 ? "google_precondition_failed" : outcomeUnknown ? "google_mutation_outcome_unknown" : "google_request_failed",
          message, route.read && retryableStatus,
          { accountId, httpStatus: response.status, ...(reason ? { reason } : {}), outcomeUnknown },
        );
      }
      throw new ConnectorError("google_request_failed", "The bounded Google request attempts were exhausted.");
    });
  }
}
