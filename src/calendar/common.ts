import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import { digest } from "../core/canonical.js";
import { ConnectorError } from "../core/errors.js";
import type { Account, ServiceDependencies, ToolSpec } from "../core/types.js";

export const SCOPES = {
  events: "https://www.googleapis.com/auth/calendar.events",
  list: "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  freeBusy: "https://www.googleapis.com/auth/calendar.events.freebusy",
} as const;
export const MAX_PAGES = 50;
export const MAX_BYTES = 1024 * 1024;
export type Event = Record<string, unknown> & {
  id: string; etag?: string; status?: string; eventType?: string; recurringEventId?: string;
  recurrence?: string[]; iCalUID?: string;
};
export type Calendar = Record<string, unknown> & { id: string; primary?: boolean; accessRole?: string; timeZone?: string };
export type Page<T> = { items?: T[]; nextPageToken?: string; [key: string]: unknown };

export function fail(code: string, message: string): never {
  throw new ConnectorError(code, message, false, { outcomeUnknown: false });
}

export async function accountWithScopes(deps: ServiceDependencies, accountId: string, scopes: string[]): Promise<Account> {
  const account = await deps.accounts.get(accountId);
  requireScopes(account, scopes);
  return account;
}

export function requireScopes(account: Account, scopes: string[]): void {
  const missingScopes = scopes.filter((scope) => !account.scopes.includes(scope));
  if (missingScopes.length) throw new ConnectorError("missing_scopes", "Reauthorize the selected account with the required Calendar scopes using the trusted account setup command.", false, { accountId: account.id, missingScopes });
}

export function eventsPath(calendarId: string, eventId?: string): string {
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId === undefined ? base : `${base}/${encodeURIComponent(eventId)}`;
}

export function assertEvent(value: unknown, expectedId?: string): asserts value is Event {
  if (!value || typeof value !== "object" || typeof (value as Event).id !== "string" || (expectedId !== undefined && (value as Event).id !== expectedId)) {
    fail("invalid_google_response", "Google returned an event with an unexpected identity.");
  }
}

export async function getEvent(deps: ServiceDependencies, account: Account, calendarId: string, eventId: string): Promise<Event> {
  const event = await deps.transport.request<unknown>(account.id, {
    api: "calendar", method: "GET", path: eventsPath(calendarId, eventId), readOnly: true,
    expectedGeneration: account.generation, maxBytes: MAX_BYTES,
  });
  assertEvent(event, eventId);
  return event;
}

export function pageItems<T>(page: Page<T>, maximum = 100): T[] {
  if (!page || typeof page !== "object" || (page.items !== undefined && !Array.isArray(page.items)) || (page.nextPageToken !== undefined && (typeof page.nextPageToken !== "string" || !page.nextPageToken || page.nextPageToken.length > 8192))) {
    fail("invalid_google_response", "Google returned an invalid Calendar page.");
  }
  const items = page.items ?? [];
  if (items.length > maximum) fail("invalid_google_response", "Google returned more Calendar items than requested.");
  return items;
}

export async function selectedCalendar(deps: ServiceDependencies, account: Account, calendarId: string): Promise<Calendar> {
  let pageToken: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await deps.transport.request<Page<Calendar>>(account.id, {
      api: "calendar", method: "GET", path: "/users/me/calendarList", readOnly: true,
      query: { maxResults: 100, pageToken, showHidden: true }, expectedGeneration: account.generation, maxBytes: MAX_BYTES,
    });
    const found = pageItems(response).find((calendar) => calendarId === "primary" ? calendar.primary === true : calendar.id === calendarId);
    if (found) {
      if (!found.id || typeof found.id !== "string" || found.deleted === true) fail("unknown_calendar", "The selected calendar metadata cannot be established.");
      return found;
    }
    pageToken = response.nextPageToken;
    if (!pageToken) break;
    if (seen.has(pageToken)) fail("pagination_cycle", "Google repeated a Calendar page token.");
    seen.add(pageToken);
    if (page === MAX_PAGES - 1) fail("calendar_discovery_limit", "Calendar discovery exceeded its 50-page bound. Narrow the account's calendar list before this write.");
  }
  fail("calendar_not_found", "The explicitly selected calendar was not found in this account's CalendarList.");
}

export function ownPrimary(account: Account, calendar: Calendar): boolean {
  return calendar.primary === true && calendar.accessRole === "owner" && calendar.id.toLowerCase() === account.email.toLowerCase();
}

export class Cursors {
  private readonly key = randomBytes(32);

  private mac(value: string): Buffer {
    return createHmac("sha256", this.key).update(value).digest();
  }

  encode(binding: unknown, token?: string): string | undefined {
    if (!token) return undefined;
    const payload = Buffer.from(JSON.stringify({ v: 1, binding: digest(binding), token })).toString("base64url");
    return `${payload}.${this.mac(payload).toString("base64url")}`;
  }

  decode(binding: unknown, cursor?: string): string | undefined {
    if (!cursor) return undefined;
    try {
      const [payload, signature, extra] = cursor.split(".");
      if (!payload || !signature || extra !== undefined) throw new Error();
      const bytes = Buffer.from(signature, "base64url");
      if (bytes.length !== 32 || !timingSafeEqual(bytes, this.mac(payload))) throw new Error();
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
      if (data.v !== 1 || data.binding !== digest(binding) || typeof data.token !== "string" || !data.token || data.token.length > 8192) throw new Error();
      return data.token;
    } catch {
      fail("invalid_cursor", "This continuation does not match the account/calendar/query or has expired with a server restart. Start a new query.");
    }
  }
}

export function tool<S extends z.ZodObject>(
  name: string, description: string, schema: S, readOnly: boolean,
  handler: (input: z.output<S>) => Promise<unknown>,
): ToolSpec {
  return {
    name, description, schema, readOnly,
    handler: async (input) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        throw new ConnectorError("invalid_input", parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "), false,
          typeof input.accountId === "string" ? { accountId: input.accountId } : undefined);
      }
      try {
        return await handler(parsed.data as z.output<S>);
      } catch (error) {
        if (error instanceof ConnectorError && typeof input.accountId === "string") {
          throw new ConnectorError(error.code, error.message, error.retryable, { ...error.details, accountId: input.accountId });
        }
        throw error;
      }
    },
  };
}
