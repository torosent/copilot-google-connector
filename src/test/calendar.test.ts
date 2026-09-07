import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../core/canonical.js";
import { ConnectorError } from "../core/errors.js";
import type { Account, GoogleRequest, MutationPlan, PrivateProvenance, ServiceDependencies } from "../core/types.js";
import { createCalendarTools } from "../calendar/index.js";
import { SCOPES, type Event } from "../calendar/common.js";
import { createSchema, updateSchema } from "../calendar/schemas.js";
import { deterministicEventId } from "../calendar/writes.js";

type Call = { accountId: string; request: GoogleRequest };
const account: Account = { id: "account-1", email: "me@example.com", subject: "subject-1", clientId: "client", generation: "generation-1", scopes: Object.values(SCOPES) };
const secondAccount: Account = { ...account, id: "account-2", email: "other@example.com", subject: "subject-2", generation: "generation-2" };
const timing = { type: "timed", start: "2026-11-02T09:00:00-08:00", end: "2026-11-02T10:00:00-08:00", timeZone: "America/Los_Angeles" } as const;
const write = { accountId: account.id, calendarId: "primary", requestId: "request-0001", sendUpdates: "none" };
const eventInput = { summary: "Private block", timing };
const window = { timeMin: "2026-11-02T08:00:00Z", timeMax: "2026-11-02T18:00:00Z" };

function privateEvent(overrides: Record<string, unknown> = {}): Event {
  return {
    id: "event1", etag: '"etag1"', status: "confirmed", eventType: "default", summary: "Existing",
    visibility: "private", transparency: "opaque", organizer: { email: account.email, self: true },
    attendees: [], start: { dateTime: timing.start, timeZone: timing.timeZone }, end: { dateTime: timing.end, timeZone: timing.timeZone },
    ...overrides,
  };
}

function fixture(options: {
  events?: Event[];
  match?: boolean;
  calendars?: Record<string, unknown>[];
  accounts?: Account[];
  provenanceFailure?: "record" | "forget";
  provenanceMatchETag?: string;
  route?: (call: Call) => unknown | Promise<unknown>;
} = {}) {
  const calls: Call[] = [];
  const plans: MutationPlan[] = [];
  const records: string[][] = [];
  const forgotten: string[][] = [];
  const matches: string[][] = [];
  const events = new Map((options.events ?? [privateEvent()]).map((event) => [event.id, structuredClone(event)]));
  const accounts = options.accounts ?? [account, secondAccount];
  const receipts = new Map<string, { hash: string; result: unknown }>();
  let reserved = false;
  const deps: ServiceDependencies & { provenance: PrivateProvenance } = {
    accounts: {
      list: async () => accounts,
      get: async (id) => {
        const value = accounts.find((item) => item.id === id);
        if (!value) throw new ConnectorError("account_not_found", "No such account.");
        return value;
      },
    },
    provenance: {
      matches: async (...args) => {
        matches.push(args);
        return (options.match ?? false) && (options.provenanceMatchETag === undefined || args[3] === options.provenanceMatchETag);
      },
      record: async (...args) => {
        records.push(args);
        if (options.provenanceFailure === "record") throw new Error("sensitive local diagnostic", { cause: new Error("nested private details") });
      },
      forget: async (...args) => {
        forgotten.push(args);
        if (options.provenanceFailure === "forget") throw new Error("sensitive local diagnostic", { cause: new Error("nested private details") });
      },
    },
    operations: {
      submit: async (accountId, requestId, intent, prepare) => {
        const key = `${accountId}/${requestId}`;
        const hash = digest(intent);
        const existing = receipts.get(key);
        if (existing) {
          if (hash !== existing.hash) throw new ConnectorError("request_id_conflict", "Different intent.");
          return existing.result;
        }
        reserved = true;
        const plan = await prepare();
        plans.push(plan);
        const result = plan.requiresApproval ? { status: "pending_approval" } : { status: "succeeded", result: await plan.execute() };
        receipts.set(key, { hash, result });
        return result;
      },
    },
    transport: {
      request: async <T>(accountId: string, request: GoogleRequest): Promise<T> => {
        const call = { accountId, request: structuredClone(request) };
        calls.push(call);
        const routed = await options.route?.(call);
        if (routed !== undefined) return structuredClone(routed) as T;
        if (request.path === "/users/me/calendarList") {
          return { items: options.calendars ?? [{ id: account.email, primary: true, accessRole: "owner", summary: "Mine", timeZone: timing.timeZone }] } as T;
        }
        if (request.path.endsWith("/events") && request.method === "GET") {
          const values = [...events.values()].filter((event) => request.query?.iCalUID === undefined || event.iCalUID === request.query.iCalUID);
          return { items: structuredClone(values) } as T;
        }
        const eventId = decodeURIComponent(request.path.split("/").at(-1)!);
        if (request.method === "GET") {
          const event = events.get(eventId);
          if (!event) throw new ConnectorError("google_not_found", "Not found.", false, { httpStatus: 404, outcomeUnknown: false });
          return structuredClone(event) as T;
        }
        if (request.method === "POST" && request.path.endsWith("/events")) {
          const body = request.body as Record<string, unknown>;
          const event = privateEvent({ ...structuredClone(body), etag: '"created"', id: body.id });
          events.set(event.id, event);
          return structuredClone(event) as T;
        }
        if (request.method === "PATCH") {
          const before = events.get(eventId)!;
          const body = structuredClone(request.body) as Record<string, unknown>;
          if (body.attendeesOmitted === true) {
            const self = (body.attendees as Array<Record<string, unknown>>)[0]!;
            body.attendees = (before.attendees as Array<Record<string, unknown>>).map((attendee) => attendee.email === self.email ? { ...attendee, ...self } : attendee);
            delete body.attendeesOmitted;
          }
          const event = { ...before, ...body, etag: '"updated"' } as Event;
          events.set(event.id, event);
          return structuredClone(event) as T;
        }
        if (request.method === "DELETE") {
          events.delete(eventId);
          return undefined as T;
        }
        throw new Error(`Unhandled fake route ${request.method} ${request.path}`);
      },
    },
  };
  const tools = createCalendarTools(deps);
  return {
    calls, plans, records, forgotten, matches, events, tools, get reserved() { return reserved; },
    run: async (name: string, input: Record<string, unknown>) => {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool);
      return await tool.handler(input) as Record<string, any>;
    },
    execute: async () => {
      assert.ok(plans.at(-1));
      return await plans.at(-1)!.execute() as Record<string, any>;
    },
    mutations: () => calls.filter(({ request }) => request.method !== "GET" && !request.readOnly),
  };
}

const hasCode = (code: string) => (error: unknown): boolean => error instanceof ConnectorError && error.code === code;

test("calendar exposes only the ten planned, strict tools", () => {
  const f = fixture();
  assert.deepEqual(f.tools.map((tool) => tool.name), [
    "calendar_list_calendars", "calendar_list_events", "calendar_get_event", "calendar_list_instances",
    "calendar_free_busy", "calendar_find_availability", "calendar_create_event", "calendar_update_event",
    "calendar_delete_event", "calendar_rsvp",
  ]);
  assert.equal(f.tools.filter((tool) => !tool.readOnly).length, 4);
  assert.equal(createSchema.safeParse({ ...write, event: { ...eventInput, status: "cancelled" } }).success, false);
  assert.equal(createSchema.safeParse({ ...write, event: { ...eventInput, eventType: "outOfOffice" } }).success, false);
  assert.equal(createSchema.safeParse({ ...write, event: { ...eventInput, attendees: [{ email: "a@example.com", responseStatus: "accepted" }] } }).success, false);
  assert.equal(createSchema.safeParse({ ...write, event: eventInput, confirmed: true }).success, false);
  assert.equal(createSchema.safeParse({ ...write, sendUpdates: undefined, event: eventInput }).success, false);
  assert.equal(createSchema.safeParse({ ...write, accountId: undefined, event: eventInput }).success, false);
  assert.equal(updateSchema.safeParse({ ...write, eventId: "event1", scope: "single", changes: { status: "cancelled" } }).success, false);
  assert.equal(updateSchema.safeParse({ ...write, eventId: "event1", scope: "this-and-following", changes: { summary: "x" } }).success, false);
});

test("calendar rejects impossible dates, DST gaps and mismatching zone offsets, but accepts both explicit fold offsets", () => {
  const valid = (value: unknown) => createSchema.safeParse({ ...write, event: { ...eventInput, timing: value } }).success;
  assert.equal(valid(timing), true);
  assert.equal(valid({ ...timing, timeZone: "Not/AZone" }), false);
  assert.equal(valid({ ...timing, timeZone: "+01:00" }), false);
  assert.equal(valid({ ...timing, start: "2026-11-02T09:00:00Z" }), false);
  assert.equal(valid({ ...timing, start: "2026-11-02T09:00:00" }), false);
  assert.equal(valid({ ...timing, start: "2026-11-02T09:00:00-00:00" }), false);
  assert.equal(valid({ ...timing, start: "2026-11-02T09:00:60-08:00" }), false);
  assert.equal(valid({ ...timing, start: "2026-03-08T02:15:00-08:00", end: "2026-03-08T04:00:00-07:00" }), false);
  assert.equal(valid({ ...timing, start: "2026-11-01T01:15:00-07:00", end: "2026-11-01T01:45:00-07:00" }), true);
  assert.equal(valid({ ...timing, start: "2026-11-01T01:15:00-08:00", end: "2026-11-01T01:45:00-08:00" }), true);
  assert.equal(valid({ type: "allDay", startDate: "2026-02-28", endDate: "2026-03-01" }), true);
  assert.equal(valid({ type: "allDay", startDate: "2026-02-28", endDate: "2026-02-28" }), false);
  assert.equal(valid({ type: "allDay", startDate: "2026-02-29", endDate: "2026-03-01" }), false);
});

test("calendar validates RRULE, RDATE and EXDATE semantics without embedded DTSTART/DTEND", () => {
  const valid = (recurrence: string[], useTiming: unknown = timing) => createSchema.safeParse({ ...write, event: { ...eventInput, timing: useTiming, recurrence } }).success;
  assert.equal(valid(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=8", "EXDATE;TZID=America/Los_Angeles:20261104T090000"]), true);
  assert.equal(valid(["RRULE:FREQ=MONTHLY;BYDAY=1MO;UNTIL=20271231T235959Z", "RDATE:20261103T170000Z"]), true);
  for (const recurrence of [
    ["DTSTART:20261102T090000Z"], ["DTEND:20261102T100000Z"],
    ["RRULE:FREQ=DAILY\nDTSTART:20261102T090000Z"],
    ["RRULE:FREQ=DAILY;COUNT=2;UNTIL=20261201T000000Z"],
    ["RRULE:FREQ=DAILY;FREQ=WEEKLY"], ["RRULE:FREQ=DAILY;BYDAY=1MO"],
    ["RRULE:FREQ=WEEKLY;BYMONTHDAY=3"], ["RRULE:FREQ=MONTHLY;BYWEEKNO=3"],
    ["RRULE:FREQ=DAILY;BYSETPOS=1"], ["RRULE:FREQ=DAILY;INTERVAL=0"],
    ["RRULE:FREQ=DAILY;BYMONTH=0"], ["RRULE:FREQ=DAILY;COUNT=2", "RRULE:FREQ=WEEKLY"],
    ["RRULE:FREQ=DAILY;UNTIL=20261102T090000"],
    ["RDATE:20261103T090000"], ["EXDATE:20261103T170000Z"],
    ["RDATE;TZID=America/Los_Angeles:20260308T023000"],
    ["RDATE;VALUE=PERIOD:20261103T170000Z/20261103T180000Z"],
  ]) assert.equal(valid(recurrence), false, recurrence.join());
  const allDay = { type: "allDay", startDate: "2026-11-02", endDate: "2026-11-03" };
  assert.equal(valid(["RRULE:FREQ=DAILY;UNTIL=20261109", "RDATE;VALUE=DATE:20261111", "EXDATE;VALUE=DATE:20261105"], allDay), true);
  assert.equal(valid(["RRULE:FREQ=DAILY;BYHOUR=9"], allDay), false);
  assert.equal(valid(["RRULE:FREQ=DAILY;UNTIL=20261109T000000Z"], allDay), false);
  assert.equal(valid(["RDATE;VALUE=DATE:20260230"], allDay), false);
});

test("calendar list uses real discovery and cursors bind account/query/limit", async () => {
  const f = fixture({ route: ({ request }) => {
    if (request.path === "/users/me/calendarList") return request.query?.pageToken ? { items: [{ id: "second" }] } : { items: [{ id: "first" }], nextPageToken: "google-token-1" };
  } });
  const first = await f.run("calendar_list_calendars", { accountId: account.id });
  assert.equal(f.calls[0]!.request.path, "/users/me/calendarList");
  assert.equal(f.calls[0]!.request.query?.maxResults, 50);
  assert.equal(first.complete, false);
  assert.equal(first.calendars[0].accountId, account.id);
  assert.equal(first.email, account.email);
  const second = await f.run("calendar_list_calendars", { accountId: account.id, cursor: first.nextCursor });
  assert.equal(second.complete, true);
  assert.equal(f.calls.at(-1)!.request.query?.pageToken, "google-token-1");
  await assert.rejects(f.run("calendar_list_calendars", { accountId: secondAccount.id, cursor: first.nextCursor }), hasCode("invalid_cursor"));
  await assert.rejects(f.run("calendar_list_calendars", { accountId: account.id, pageSize: 100, cursor: first.nextCursor }), hasCode("invalid_cursor"));
  await assert.rejects(f.run("calendar_list_calendars", { accountId: account.id, pageSize: 101 }), hasCode("invalid_input"));
});

test("calendar discovery, event and instance cursors reject account generation changes before another read", async () => {
  for (const { name, input, items } of [
    { name: "calendar_list_calendars", input: { accountId: account.id }, items: [{ id: account.email }] },
    { name: "calendar_list_events", input: { accountId: account.id, calendarId: "primary", ...window }, items: [privateEvent()] },
    {
      name: "calendar_list_instances", input: { accountId: account.id, calendarId: "primary", eventId: "master", ...window },
      items: [privateEvent({ id: "instance1", recurringEventId: "master", originalStartTime: { dateTime: timing.start } })],
    },
  ]) {
    const changingAccount = { ...account };
    const f = fixture({ accounts: [changingAccount], route: () => ({ items, nextPageToken: "next-page" }) });
    const first = await f.run(name, input);
    assert.equal(typeof first.nextCursor, "string");
    await f.run(name, { ...input, cursor: first.nextCursor });
    const beforeReauth = f.calls.length;
    changingAccount.generation = "generation-after-reauth";
    await assert.rejects(f.run(name, { ...input, cursor: first.nextCursor }), hasCode("invalid_cursor"), name);
    assert.equal(f.calls.length, beforeReauth, name);
  }
});

test("calendar search requires explicit expansion bounds and binds query continuation", async () => {
  const f = fixture({ route: ({ request }) => request.path.endsWith("/events") ? { items: [privateEvent()], nextPageToken: "page2" } : undefined });
  const calendarId = "en.usa#holiday@group.v.calendar.google.com";
  await assert.rejects(f.run("calendar_list_events", { accountId: account.id, calendarId }), hasCode("invalid_input"));
  assert.equal(f.calls.length, 0);
  const first = await f.run("calendar_list_events", { accountId: account.id, calendarId, query: "demo", ...window });
  assert.equal(f.calls[0]!.request.path, "/calendars/en.usa%23holiday%40group.v.calendar.google.com/events");
  assert.equal(f.calls[0]!.request.query?.q, "demo");
  assert.equal(first.events[0].calendarId, calendarId);
  await assert.rejects(f.run("calendar_list_events", { accountId: account.id, calendarId, query: "different", ...window, cursor: first.nextCursor }), hasCode("invalid_cursor"));
  await f.run("calendar_list_events", { accountId: account.id, calendarId, singleEvents: false });
});

test("calendar reads preserve moved occurrence identity and originalStartTime", async () => {
  const moved = privateEvent({ id: "google_instance", recurringEventId: "master", originalStartTime: { dateTime: "2026-11-02T09:00:00-08:00" }, start: { dateTime: "2026-11-03T09:00:00-08:00" } });
  const f = fixture({ events: [moved], route: ({ request }) => request.path.endsWith("/instances") ? { items: [moved] } : undefined });
  const result = await f.run("calendar_list_instances", { accountId: account.id, calendarId: "primary", eventId: "master", ...window });
  assert.equal(result.events[0].id, "google_instance");
  assert.deepEqual(result.events[0].originalStartTime, moved.originalStartTime);
  assert.equal(f.calls[0]!.request.path, "/calendars/primary/events/master/instances");
  const fetched = await f.run("calendar_get_event", { accountId: account.id, calendarId: "primary", eventId: moved.id });
  assert.equal(fetched.event.email, account.email);
});

test("calendar missing free/busy scope and forbidden calendars remain unknown", async () => {
  const f = fixture({
    accounts: [account, { ...secondAccount, scopes: [SCOPES.events] }],
    route: ({ request }) => request.path === "/freeBusy" ? { calendars: { good: { busy: [] }, forbidden: { errors: [{ reason: "forbidden" }] } } } : undefined,
  });
  const result = await f.run("calendar_find_availability", {
    ...window, durationMinutes: 30, calendars: [
      { accountId: account.id, calendarId: "good" }, { accountId: account.id, calendarId: "forbidden" },
      { accountId: secondAccount.id, calendarId: "other" },
    ],
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.slots, []);
  assert.equal(result.sources[0].known, true);
  assert.equal(result.sources[1].known, false);
  assert.equal(result.sources[2].error.code, "missing_scopes");
  assert.equal(result.sources[2].accountId, secondAccount.id);
  assert.equal(result.sources[2].email, secondAccount.email);
  assert.equal(f.mutations().length, 0);
});

test("calendar free/busy partitions credentials, batches 50 and caps concurrency at four", async () => {
  let concurrent = 0;
  let peak = 0;
  const f = fixture({ route: async ({ request }) => {
    if (request.path !== "/freeBusy") return undefined;
    concurrent++;
    peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    concurrent--;
    const items = (request.body as { items: { id: string }[] }).items;
    assert.ok(items.length <= 50);
    return { calendars: Object.fromEntries(items.map((item) => [item.id, { busy: [] }])) };
  } });
  const calendars = Array.from({ length: 190 }, (_, i) => ({ accountId: i < 151 ? account.id : secondAccount.id, calendarId: `calendar-${i}` }));
  const result = await f.run("calendar_free_busy", { ...window, calendars });
  assert.equal(result.complete, true);
  assert.equal(result.sources.length, 190);
  assert.equal(f.calls.length, 5);
  assert.equal(peak, 4);
  for (const { accountId, request } of f.calls) {
    assert.equal(request.readOnly, true);
    for (const item of (request.body as { items: { id: string }[] }).items) assert.equal(accountId, Number(item.id.split("-")[1]) < 151 ? account.id : secondAccount.id);
  }
});

test("calendar common availability unions and clips busy intervals with source provenance", async () => {
  const f = fixture({ route: ({ accountId, request }) => request.path === "/freeBusy" ? {
    calendars: { selected: { busy: accountId === account.id
      ? [{ start: "2026-11-02T07:00:00Z", end: "2026-11-02T10:00:00Z" }, { start: "2026-11-02T13:00:00Z", end: "2026-11-02T14:00:00Z" }]
      : [{ start: "2026-11-02T09:00:00Z", end: "2026-11-02T11:00:00Z" }, { start: "2026-11-02T14:00:00Z", end: "2026-11-02T20:00:00Z" }] } },
  } : undefined });
  const result = await f.run("calendar_find_availability", {
    ...window, durationMinutes: 60, calendars: [{ accountId: account.id, calendarId: "selected" }, { accountId: secondAccount.id, calendarId: "selected" }],
  });
  assert.equal(result.complete, true);
  assert.deepEqual(result.slots, [{ start: "2026-11-02T11:00:00.000Z", end: "2026-11-02T13:00:00.000Z", availableMinutes: 120 }]);
  assert.equal(result.sources[1].email, secondAccount.email);
});

test("calendar availability rejects oversized/ambiguous windows and treats malformed intervals as unknown", async () => {
  const f = fixture({ route: ({ request }) => request.path === "/freeBusy" ? { calendars: { primary: { busy: [{ start: "tomorrow", end: "never" }] } } } : undefined });
  const base = { calendars: [{ accountId: account.id, calendarId: "primary" }], durationMinutes: 30 };
  await assert.rejects(f.run("calendar_find_availability", { ...base, timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-02-02T00:00:00Z" }), hasCode("invalid_input"));
  await assert.rejects(f.run("calendar_find_availability", { ...base, ...window, timeMin: "2026-11-02T08:00:00" }), hasCode("invalid_input"));
  const result = await f.run("calendar_find_availability", { ...base, ...window });
  assert.equal(result.complete, false);
  assert.deepEqual(result.slots, []);
  await assert.rejects(f.run("calendar_find_availability", { ...base, timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-02-01T00:00:00.000000001Z" }), hasCode("invalid_input"));
});

test("calendar availability rounds submillisecond busy bounds conservatively rather than inventing free time", async () => {
  const f = fixture({ route: ({ request }) => request.path === "/freeBusy" ? {
    calendars: { primary: { busy: [{ start: "2026-11-02T07:59:00Z", end: "2026-11-02T08:00:00.000001Z" }] } },
  } : undefined });
  const result = await f.run("calendar_find_availability", {
    calendars: [{ accountId: account.id, calendarId: "primary" }], durationMinutes: 1,
    timeMin: "2026-11-02T08:00:00Z", timeMax: "2026-11-02T08:01:00Z",
  });
  assert.deepEqual(result.slots, []);
  assert.deepEqual(result.sources[0].busy, [{ start: "2026-11-02T08:00:00.000Z", end: "2026-11-02T08:00:00.001Z" }]);
});

test("calendar private create reserves before reads, emits deterministic ID and records safe provenance", async () => {
  const f = fixture({ route: ({ request }) => {
    if (request.method === "GET") assert.equal(f.reserved, true);
  } });
  const result = await f.run("calendar_create_event", { ...write, event: eventInput });
  assert.equal(result.status, "succeeded");
  assert.equal(result.email, account.email);
  assert.equal(f.plans[0]!.requiresApproval, false);
  const call = f.mutations()[0]!;
  assert.equal(call.request.path, `/calendars/${encodeURIComponent(account.email)}/events`);
  assert.equal(call.request.expectedGeneration, account.generation);
  assert.equal(call.request.query?.sendUpdates, "none");
  const body = call.request.body as Record<string, any>;
  assert.match(body.id, /^[0-9a-v]{5,1024}$/);
  assert.equal(body.id, deterministicEventId(account.id, account.email, write.requestId));
  assert.deepEqual(body.attendees, []);
  assert.ok(body.extendedProperties.private.copilotConnectorOperation);
  assert.deepEqual(f.records, [[account.id, account.email, body.id, '"created"']]);
  const callCount = f.calls.length;
  await f.run("calendar_create_event", { ...write, event: eventInput });
  assert.equal(f.calls.length, callCount);
  await assert.rejects(f.run("calendar_create_event", { ...write, event: { ...eventInput, summary: "Changed intent" } }), hasCode("request_id_conflict"));
  assert.equal(f.calls.length, callCount);
});

test("calendar private recurring create needs no approval but grants no private-edit provenance", async () => {
  const f = fixture();
  const created = await f.run("calendar_create_event", {
    ...write, event: { ...eventInput, recurrence: ["RRULE:FREQ=DAILY;COUNT=2"] },
  });
  assert.equal(created.status, "succeeded");
  assert.equal(f.plans[0]!.requiresApproval, false);
  assert.equal(created.result.provenanceRecorded, false);
  assert.equal(f.records.length, 0);
  const series = f.events.get(created.result.eventId)!;
  series.iCalUID = "new-private-series";
  const updated = await f.run("calendar_update_event", {
    ...write, requestId: "request-series-edit", eventId: series.id,
    scope: "series", changes: { summary: "Changed private series" },
  });
  assert.equal(updated.status, "pending_approval");
  assert.equal(f.plans.at(-1)!.requiresApproval, true);
  assert.equal(f.records.length, 0);
});

test("calendar never records private-edit provenance for a requested series with omitted response recurrence", async () => {
  const f = fixture({
    route: ({ request }) => request.method === "POST"
      ? privateEvent({ ...request.body as Record<string, unknown>, recurrence: undefined, etag: '"created"' })
      : undefined,
  });
  const created = await f.run("calendar_create_event", {
    ...write, event: { ...eventInput, recurrence: ["RRULE:FREQ=DAILY;COUNT=2"] },
  });
  assert.equal(created.status, "succeeded");
  assert.equal(created.result.provenanceRecorded, false);
  assert.equal(f.records.length, 0);
});

test("calendar all-day create keeps exclusive end date and does not invent times", async () => {
  const f = fixture();
  await f.run("calendar_create_event", { ...write, event: { summary: "Day off", timing: { type: "allDay", startDate: "2026-11-02", endDate: "2026-11-03" } } });
  const body = f.mutations()[0]!.request.body as Record<string, unknown>;
  assert.deepEqual(body.start, { date: "2026-11-02" });
  assert.deepEqual(body.end, { date: "2026-11-03" });
});

test("calendar timing patches clear mutually exclusive date/dateTime fields without obscuring the after preview", async () => {
  const f = fixture();
  await f.run("calendar_update_event", {
    ...write, eventId: "event1", scope: "single",
    changes: { timing: { type: "allDay", startDate: "2026-11-02", endDate: "2026-11-03" } },
  });
  const preview = f.plans[0]!.preview as Record<string, any>;
  assert.deepEqual(preview.after.start, { date: "2026-11-02" });
  assert.deepEqual(preview.patch.start, { date: "2026-11-02", dateTime: null, timeZone: null });
  await f.execute();
  const allDay = fixture({ events: [privateEvent({ start: { date: "2026-11-02" }, end: { date: "2026-11-03" } })] });
  await allDay.run("calendar_update_event", { ...write, eventId: "event1", scope: "single", changes: { timing } });
  assert.deepEqual((allDay.plans[0]!.preview.patch as Record<string, unknown>).start, { date: null, dateTime: timing.start, timeZone: timing.timeZone });
});

test("calendar create approval classification covers attendees, visibility, notifications and ownership", async () => {
  for (const extra of [
    { event: { ...eventInput, attendees: [{ email: "guest@example.com" }] } },
    { event: { ...eventInput, visibility: "default" } },
    { event: eventInput, sendUpdates: "all" },
    { event: eventInput, sendUpdates: "externalOnly" },
  ]) {
    const f = fixture();
    const result = await f.run("calendar_create_event", { ...write, ...extra });
    assert.equal(result.status, "pending_approval");
    assert.equal(f.mutations().length, 0);
  }
  const shared = fixture({ calendars: [{ id: "shared@example.com", primary: false, accessRole: "owner" }] });
  await shared.run("calendar_create_event", { ...write, calendarId: "shared@example.com", event: eventInput });
  assert.equal(shared.plans[0]!.requiresApproval, true);
  assert.equal(shared.mutations().length, 0);
  const spoofed = fixture({ calendars: [{ id: "someone@example.com", primary: true, accessRole: "owner" }] });
  await spoofed.run("calendar_create_event", { ...write, event: eventInput });
  assert.equal(spoofed.plans[0]!.requiresApproval, true);
});

test("calendar invitations begin needsAction and approval previews exact account, attendees and sendUpdates effects", async () => {
  const f = fixture();
  await f.run("calendar_create_event", { ...write, sendUpdates: "externalOnly", event: { ...eventInput, attendees: [{ email: "Guest@Example.com", displayName: "Guest" }] } });
  const preview = f.plans[0]!.preview as Record<string, any>;
  assert.equal(preview.accountId, account.id);
  assert.equal(preview.email, account.email);
  assert.deepEqual(preview.attendees.current, []);
  assert.deepEqual(preview.attendees.added, [{ email: "guest@example.com", displayName: "Guest", responseStatus: "needsAction" }]);
  assert.match(preview.notifications.requestedDelivery, /domain alone does not prove/);
  await f.execute();
  assert.equal(f.mutations()[0]!.request.query?.sendUpdates, "externalOnly");
});

test("calendar private update requires before-and-after qualification and exact provenance", async () => {
  const input = { ...write, eventId: "event1", scope: "single", changes: { summary: "Moved private block" } };
  const safe = fixture({ match: true });
  assert.equal((await safe.run("calendar_update_event", input)).status, "succeeded");
  assert.deepEqual(safe.matches, [[account.id, account.email, "event1", '"etag1"']]);
  assert.deepEqual(safe.records, [[account.id, account.email, "event1", '"updated"']]);
  assert.equal(safe.mutations()[0]!.request.headers?.["If-Match"], '"etag1"');
  assert.equal(safe.mutations()[0]!.request.expectedGeneration, account.generation);
  const missing = fixture({ match: false });
  assert.equal((await missing.run("calendar_update_event", input)).status, "pending_approval");
  assert.equal(missing.mutations().length, 0);
  const changed = fixture({ match: true, events: [privateEvent({ visibility: "public" })] });
  await changed.run("calendar_update_event", { ...input, changes: { visibility: "private" } });
  assert.equal(changed.plans[0]!.requiresApproval, true);
  const guests = fixture({ match: true, events: [privateEvent({ attendees: [{ email: "guest@example.com", responseStatus: "accepted" }] })] });
  await guests.run("calendar_update_event", { ...input, changes: { attendees: { mode: "replace", attendees: [] } } });
  assert.equal(guests.plans[0]!.requiresApproval, true);
  const preview = guests.plans[0]!.preview as Record<string, any>;
  assert.deepEqual(preview.attendees.removed, [{ email: "guest@example.com", responseStatus: "accepted" }]);
  await guests.execute();
  assert.equal(guests.records.length, 0);
  assert.deepEqual(guests.forgotten, [[account.id, account.email, "event1"]]);
});

test("calendar all successful mutation types explicitly warn about provenance failures without retrying Google", async () => {
  const invited = privateEvent({
    organizer: { email: "organizer@example.com" },
    attendees: [{ email: account.email, self: true, responseStatus: "needsAction" }],
  });
  const cases = [
    { name: "calendar_create_event", input: { ...write, event: eventInput }, failure: "record", match: false },
    { name: "calendar_create_event", input: { ...write, event: { ...eventInput, attendees: [{ email: "guest@example.com" }] } }, failure: "forget", match: false },
    { name: "calendar_update_event", input: { ...write, eventId: "event1", scope: "single", changes: { summary: "Updated" } }, failure: "record", match: true },
    { name: "calendar_update_event", input: { ...write, eventId: "event1", scope: "single", changes: { summary: "Updated" } }, failure: "forget", match: false },
    { name: "calendar_delete_event", input: { ...write, eventId: "event1", scope: "single" }, failure: "forget", match: false },
    { name: "calendar_rsvp", input: { ...write, eventId: "event1", scope: "single", responseStatus: "accepted" }, failure: "forget", match: false },
  ] as const;
  for (const example of cases) {
    const f = fixture({
      match: example.match, provenanceFailure: example.failure,
      events: [example.name === "calendar_rsvp" ? invited : privateEvent()],
    });
    const envelope = await f.run(example.name, example.input);
    const result = envelope.status === "pending_approval" ? await f.execute() : envelope.result;
    assert.equal(result.provenanceRecorded, false, example.name);
    assert.equal(result.provenanceWarning.code, "private_provenance_maintenance_failed");
    assert.match(result.provenanceWarning.message, /Google mutation succeeded/);
    assert.match(result.provenanceWarning.message, /Do not retry the Google mutation/);
    assert.match(result.provenanceWarning.message, /Later private edits must require approval/);
    assert.equal(JSON.stringify(result).includes("sensitive local diagnostic"), false);
    assert.equal(JSON.stringify(result).includes("nested private details"), false);
    assert.equal(result.accountId, account.id);
    assert.equal(result.email, account.email);
    assert.equal(f.mutations().length, 1, example.name);
    if (envelope.status === "succeeded") {
      const calls = f.calls.length;
      const retried = await f.run(example.name, example.input);
      assert.deepEqual(retried.result.provenanceWarning, result.provenanceWarning);
      assert.equal(f.calls.length, calls, example.name);
    }
  }
});

test("calendar failed provenance renewal leaves old ETag unable to authorize a later private edit", async () => {
  const f = fixture({ match: true, provenanceMatchETag: '"etag1"', provenanceFailure: "record" });
  const input = { ...write, eventId: "event1", scope: "single", changes: { summary: "First edit" } };
  const first = await f.run("calendar_update_event", input);
  assert.equal(first.status, "succeeded");
  assert.ok(first.result.provenanceWarning);
  assert.equal(first.result.etag, '"updated"');
  assert.equal(f.mutations()[0]!.request.headers?.["If-Match"], '"etag1"');
  const next = await f.run("calendar_update_event", { ...input, requestId: "request-0002", changes: { summary: "Later edit" } });
  assert.equal(next.status, "pending_approval");
  assert.equal(f.mutations().length, 1);
  assert.equal(f.matches.at(-1)?.[3], '"updated"');
});

test("calendar incomplete participants and special event effects fail closed", async () => {
  const input = { ...write, eventId: "event1", scope: "single", changes: { summary: "Change" } };
  const omitted = fixture({ match: true, events: [privateEvent({ attendeesOmitted: true })] });
  await assert.rejects(omitted.run("calendar_update_event", input), hasCode("incomplete_attendees"));
  assert.equal(omitted.mutations().length, 0);
  const special = fixture({ match: true, events: [privateEvent({ eventType: "focusTime", focusTimeProperties: { autoDeclineMode: "declineAllConflictingInvitations" } })] });
  await assert.rejects(special.run("calendar_update_event", input), hasCode("unsupported_event_type"));
  const cancelled = fixture({ match: true, events: [privateEvent({ status: "cancelled" })] });
  await assert.rejects(cancelled.run("calendar_update_event", input), hasCode("cancelled_event"));
});

test("calendar attendee replacement preserves old responses and previews full removed/added lists", async () => {
  const before = [
    { email: "keep@example.com", responseStatus: "accepted", comment: "See you there", optional: false },
    { email: "remove@example.com", responseStatus: "tentative", additionalGuests: 1 },
  ];
  const f = fixture({ events: [privateEvent({ attendees: before })] });
  await f.run("calendar_update_event", {
    ...write, sendUpdates: "all", eventId: "event1", scope: "single",
    changes: { attendees: { mode: "replace", attendees: [{ email: "KEEP@example.com", optional: true }, { email: "new@example.com" }] } },
  });
  const preview = f.plans[0]!.preview as Record<string, any>;
  assert.deepEqual(preview.attendees.current, before);
  assert.deepEqual(preview.attendees.removed, [before[1]]);
  assert.deepEqual(preview.attendees.added, [{ email: "new@example.com", responseStatus: "needsAction" }]);
  await f.execute();
  const attendees = (f.mutations()[0]!.request.body as { attendees: unknown[] }).attendees;
  assert.deepEqual(attendees, [{ ...before[0], optional: true }, { email: "new@example.com", responseStatus: "needsAction" }]);
});

test("calendar deletion always requires approval and uses the exact target ETag", async () => {
  const f = fixture({ match: true });
  await f.run("calendar_delete_event", { ...write, eventId: "event1", scope: "single" });
  assert.equal(f.plans[0]!.requiresApproval, true);
  assert.equal(f.mutations().length, 0);
  assert.equal(f.plans[0]!.preview.after, null);
  await f.execute();
  assert.equal(f.mutations()[0]!.request.method, "DELETE");
  assert.equal(f.mutations()[0]!.request.headers?.["If-Match"], '"etag1"');
  assert.equal(f.mutations()[0]!.request.expectedGeneration, account.generation);
});

test("calendar ETag conflict is a definite non-retryable failure", async () => {
  const f = fixture({ route: ({ request }) => {
    if (request.method === "PATCH") throw new ConnectorError("google_error", "Changed", false, { httpStatus: 412 });
  } });
  await f.run("calendar_update_event", { ...write, eventId: "event1", scope: "single", changes: { summary: "Change" } });
  await assert.rejects(f.execute(), (error) => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "etag_conflict");
    assert.equal(error.details?.outcomeUnknown, false);
    return true;
  });
  assert.equal(f.mutations().length, 1);
  assert.equal(f.records.length, 0);
});

test("calendar malformed mutation responses stay outcome-unknown and cannot establish provenance", async () => {
  const f = fixture({ route: ({ request }) => request.method === "PATCH" ? { id: "event1" } : undefined });
  await f.run("calendar_update_event", { ...write, eventId: "event1", scope: "single", changes: { summary: "Change" } });
  await assert.rejects(f.execute(), (error) => error instanceof ConnectorError && error.code === "invalid_mutation_response" && error.details?.outcomeUnknown === true);
  assert.equal(f.mutations().length, 1);
  assert.equal(f.records.length, 0);
});

function seriesFixture(exception = false) {
  const master = privateEvent({ id: "master", iCalUID: "uid1", recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"] });
  const occurrence = privateEvent({
    id: "google_occurrence", etag: '"instance1"', iCalUID: "uid1", recurringEventId: "master",
    originalStartTime: { dateTime: timing.start, timeZone: timing.timeZone },
    start: { dateTime: "2026-11-03T09:00:00-08:00", timeZone: timing.timeZone },
    end: { dateTime: "2026-11-03T10:00:00-08:00", timeZone: timing.timeZone },
  });
  return { master, occurrence, f: fixture({ match: true, events: exception ? [master, occurrence] : [master] }) };
}

test("calendar series edits always require approval and inspect/recheck persisted exceptions", async () => {
  const { f, master } = seriesFixture();
  await f.run("calendar_update_event", { ...write, eventId: master.id, scope: "series", changes: { summary: "Whole series" } });
  assert.equal(f.plans[0]!.requiresApproval, true);
  assert.equal(f.matches.length, 0);
  const preview = f.plans[0]!.preview as Record<string, any>;
  assert.match(preview.recurrence.preconditionLimit, /not an atomic/);
  assert.equal(f.calls.filter(({ request }) => request.query?.iCalUID === "uid1").length, 1);
  await f.execute();
  assert.equal(f.calls.filter(({ request }) => request.query?.iCalUID === "uid1").length, 2);
  assert.equal(f.mutations()[0]!.request.headers?.["If-Match"], master.etag);
  assert.equal((f.mutations()[0]!.request.body as Record<string, unknown>).recurrence, undefined);
});

test("calendar fails closed on series exceptions and never silently changes requested scope", async () => {
  const { f, master, occurrence } = seriesFixture(true);
  await assert.rejects(f.run("calendar_update_event", { ...write, eventId: master.id, scope: "series", changes: { summary: "All" } }), hasCode("series_has_exceptions"));
  await assert.rejects(f.run("calendar_update_event", { ...write, eventId: occurrence.id, scope: "series", changes: { summary: "All" } }), hasCode("recurrence_scope_mismatch"));
  await assert.rejects(f.run("calendar_update_event", { ...write, eventId: master.id, scope: "single", changes: { summary: "One" } }), hasCode("recurrence_scope_mismatch"));
  await assert.rejects(f.run("calendar_update_event", { ...write, eventId: occurrence.id, scope: "occurrence", changes: { recurrence: [] } }), hasCode("recurrence_scope_mismatch"));
  assert.equal(f.mutations().length, 0);
});

test("calendar series execution rechecks exceptions and fails on newly discovered exceptions", async () => {
  const { f, master, occurrence } = seriesFixture();
  await f.run("calendar_delete_event", { ...write, eventId: master.id, scope: "series" });
  f.events.set(occurrence.id, occurrence);
  await assert.rejects(f.execute(), hasCode("series_has_exceptions"));
  assert.equal(f.mutations().length, 0);
});

test("calendar series scans have cycle detection and a hard 50-page bound", async () => {
  const master = privateEvent({ id: "master", iCalUID: "uid1", recurrence: ["RRULE:FREQ=DAILY"] });
  let pages = 0;
  const f = fixture({ events: [master], route: ({ request }) => {
    if (request.query?.iCalUID) return { items: pages++ === 0 ? [master] : [], nextPageToken: `token${pages}` };
  } });
  await assert.rejects(f.run("calendar_delete_event", { ...write, eventId: master.id, scope: "series" }), hasCode("series_scan_limit"));
  assert.equal(pages, 50);
  assert.equal(f.mutations().length, 0);
  const cycle = fixture({ events: [master], route: ({ request }) => {
    if (request.query?.iCalUID) return { items: request.query.pageToken ? [] : [master], nextPageToken: "cycle" };
  } });
  await assert.rejects(cycle.run("calendar_delete_event", { ...write, eventId: master.id, scope: "series" }), hasCode("pagination_cycle"));
});

test("calendar moved occurrence edits target Google's ID and guard the master ETag separately", async () => {
  const { f, master, occurrence } = seriesFixture(true);
  await f.run("calendar_update_event", { ...write, eventId: occurrence.id, scope: "occurrence", changes: { summary: "One moved instance" } });
  const preview = f.plans[0]!.preview as Record<string, any>;
  assert.deepEqual(preview.recurrence.originalStartTime, occurrence.originalStartTime);
  assert.equal(preview.recurrence.masterEventId, master.id);
  assert.equal(preview.recurrence.occurrenceId, occurrence.id);
  await f.execute();
  assert.equal(f.mutations()[0]!.request.path, `/calendars/${encodeURIComponent(account.email)}/events/google_occurrence`);
  assert.equal(f.mutations()[0]!.request.headers?.["If-Match"], '"instance1"');
  const changed = seriesFixture(true);
  await changed.f.run("calendar_delete_event", { ...write, eventId: changed.occurrence.id, scope: "occurrence" });
  changed.f.events.get("master")!.etag = '"master-changed"';
  await assert.rejects(changed.f.execute(), hasCode("series_changed"));
  assert.equal(changed.f.mutations().length, 0);
});

test("calendar missing occurrence identity or target ETag cannot prepare a write", async () => {
  const f = fixture({ events: [privateEvent({ etag: undefined })] });
  await assert.rejects(f.run("calendar_update_event", { ...write, eventId: "event1", scope: "single", changes: { summary: "x" } }), hasCode("missing_event_etag"));
  const bad = fixture({ events: [privateEvent({ recurringEventId: "master" })] });
  await assert.rejects(bad.run("calendar_delete_event", { ...write, eventId: "event1", scope: "occurrence" }), hasCode("unknown_occurrence"));
});

test("calendar self-RSVP uses participant-only semantics and cannot spoof others' responses", async () => {
  const invited = privateEvent({
    organizer: { email: "organizer@example.com" },
    attendees: [
      { email: account.email, self: true, responseStatus: "needsAction" },
      { email: "other@example.com", responseStatus: "accepted" },
    ],
  });
  const f = fixture({ events: [invited] });
  await f.run("calendar_rsvp", { ...write, eventId: invited.id, scope: "single", responseStatus: "accepted" });
  assert.equal(f.plans[0]!.requiresApproval, true);
  assert.equal(f.mutations().length, 0);
  const result = await f.execute();
  assert.deepEqual(f.mutations()[0]!.request.body, { attendeesOmitted: true, attendees: [{ email: account.email, responseStatus: "accepted" }] });
  assert.equal(result.event.attendees.length, 2);
  assert.equal(result.event.attendees[1].responseStatus, "accepted");
  assert.equal(f.records.length, 0);
  const shared = fixture({ events: [invited], calendars: [{ id: "shared@example.com", accessRole: "writer" }] });
  await assert.rejects(shared.run("calendar_rsvp", { ...write, calendarId: "shared@example.com", eventId: invited.id, scope: "single", responseStatus: "declined" }), hasCode("rsvp_not_own_primary"));
  const wrong = fixture({ events: [privateEvent({ organizer: { email: "organizer@example.com" }, attendees: [{ email: "victim@example.com", self: true }] })] });
  await assert.rejects(wrong.run("calendar_rsvp", { ...write, eventId: "event1", scope: "single", responseStatus: "accepted" }), hasCode("rsvp_identity_unproven"));
  assert.equal(wrong.mutations().length, 0);
  const hidden = fixture({ events: [{ ...invited, guestsCanSeeOtherGuests: false }] });
  await assert.rejects(hidden.run("calendar_rsvp", { ...write, eventId: invited.id, scope: "single", responseStatus: "accepted" }), hasCode("incomplete_attendees"));
  const organizer = fixture({ events: [privateEvent({ attendees: [{ email: account.email, self: true }] })] });
  await assert.rejects(organizer.run("calendar_rsvp", { ...write, eventId: "event1", scope: "single", responseStatus: "accepted" }), hasCode("rsvp_identity_unproven"));
});

test("calendar read-only roles, missing event scopes and missing organizers cannot dispatch", async () => {
  const readOnly = fixture({ calendars: [{ id: account.email, primary: true, accessRole: "reader" }] });
  await assert.rejects(readOnly.run("calendar_create_event", { ...write, event: eventInput }), hasCode("calendar_read_only"));
  const noScope = fixture({ accounts: [{ ...account, scopes: [SCOPES.list] }] });
  await assert.rejects(noScope.run("calendar_create_event", { ...write, event: eventInput }), hasCode("missing_scopes"));
  assert.equal(noScope.calls.length, 0);
  const unknown = fixture({ events: [privateEvent({ organizer: undefined })] });
  await assert.rejects(unknown.run("calendar_delete_event", { ...write, eventId: "event1", scope: "single" }), hasCode("unknown_organizer"));
  assert.equal(unknown.mutations().length, 0);
});

test("calendar deterministic create reconciles duplicate 409 only with the exact private marker", async () => {
  const f = fixture({ route: ({ request }) => {
    if (request.method === "POST") {
      const body = request.body as Record<string, unknown>;
      f.events.set(body.id as string, privateEvent({ ...body, etag: '"reconciled"' }));
      throw new ConnectorError("conflict", "Duplicate", false, { httpStatus: 409, outcomeUnknown: false });
    }
  } });
  const result = await f.run("calendar_create_event", { ...write, event: eventInput });
  assert.equal(result.result.reconciled, true);
  assert.equal(result.result.provenanceRecorded, false);
  assert.equal(f.mutations().length, 1);
  assert.equal(f.calls.at(-1)!.request.path.split("/").at(-1), deterministicEventId(account.id, account.email, write.requestId));
  const wrong = fixture({ route: ({ request }) => {
    if (request.method === "POST") {
      const body = request.body as Record<string, unknown>;
      wrong.events.set(body.id as string, privateEvent({ id: body.id, extendedProperties: { private: { copilotConnectorOperation: "not-this-operation" } } }));
      throw new ConnectorError("conflict", "Duplicate", false, { httpStatus: 409, outcomeUnknown: false });
    }
  } });
  await assert.rejects(wrong.run("calendar_create_event", { ...write, event: eventInput }), hasCode("create_id_conflict"));
  assert.equal(wrong.mutations().length, 1);
  assert.equal(wrong.records.length, 0);
});

test("calendar ambiguous create reads only the same deterministic ID and never sends a second mutation", async () => {
  const f = fixture({ route: ({ request }) => {
    if (request.method === "POST") throw new ConnectorError("network", "Lost response", false, { outcomeUnknown: true });
  } });
  await assert.rejects(f.run("calendar_create_event", { ...write, event: eventInput }), (error) => error instanceof ConnectorError && error.details?.outcomeUnknown === true);
  assert.equal(f.mutations().length, 1);
  assert.equal(f.calls.at(-1)!.request.path.split("/").at(-1), deterministicEventId(account.id, account.email, write.requestId));
  assert.notEqual(deterministicEventId(account.id, account.email, write.requestId), deterministicEventId(secondAccount.id, account.email, write.requestId));
  assert.notEqual(deterministicEventId(account.id, account.email, write.requestId), deterministicEventId(account.id, "other-calendar", write.requestId));
});
