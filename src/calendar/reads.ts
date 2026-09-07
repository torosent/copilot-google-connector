import type { z } from "zod";
import { publicError } from "../core/errors.js";
import type { ServiceDependencies, ToolSpec } from "../core/types.js";
import {
  accountWithScopes, assertEvent, Cursors, eventsPath, fail, getEvent, MAX_BYTES, pageItems, requireScopes, SCOPES, tool,
  type Calendar, type Event, type Page,
} from "./common.js";
import {
  availabilitySchema, freeBusySchema, getEventSchema, instancesSchema, listCalendarsSchema, listEventsSchema,
} from "./schemas.js";
import { instant } from "./time.js";

type Interval = { start: string; end: string };
type BusySource = {
  accountId: string; email: string | null; calendarId: string; known: boolean;
  busy: Interval[]; error?: Record<string, unknown>;
};
type FreeBusyResponse = { calendars?: Record<string, { busy?: Interval[]; errors?: unknown[] }>; groups?: unknown };

function milliseconds(value: string, roundUp = false): number {
  const time = instant(value);
  return time.epochMilliseconds + (roundUp && time.epochNanoseconds % 1_000_000n !== 0n ? 1 : 0);
}

function normalizedIntervals(intervals: Interval[], min: number, max: number): [number, number][] {
  return intervals.map((interval): [number, number] => {
    if (instant(interval.start).epochNanoseconds >= instant(interval.end).epochNanoseconds) throw new Error("Invalid busy interval.");
    const start = milliseconds(interval.start);
    const end = milliseconds(interval.end, true);
    return [Math.max(start, min), Math.min(end, max)];
  }).filter(([start, end]) => start < end).sort((a, b) => a[0] - b[0]);
}

export function mergeIntervals(intervals: [number, number][]): [number, number][] {
  const merged: [number, number][] = [];
  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const formatInterval = ([start, end]: [number, number]): Interval => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });

async function gatherBusy(deps: ServiceDependencies, input: z.infer<typeof freeBusySchema>): Promise<BusySource[]> {
  const result: BusySource[] = input.calendars.map((source) => ({ ...source, email: null, known: false, busy: [] }));
  const grouped = new Map<string, number[]>();
  result.forEach((source, index) => grouped.set(source.accountId, [...(grouped.get(source.accountId) ?? []), index]));
  const jobs: Array<() => Promise<void>> = [];
  // Busy coverage rounds outward; common-free windows below round inward.
  const min = milliseconds(input.timeMin);
  const max = milliseconds(input.timeMax, true);
  for (const [accountId, indices] of grouped) {
    for (let offset = 0; offset < indices.length; offset += 50) {
      const batch = indices.slice(offset, offset + 50);
      jobs.push(async () => {
        try {
          const account = await deps.accounts.get(accountId);
          for (const index of batch) result[index]!.email = account.email;
          requireScopes(account, [SCOPES.freeBusy]);
          const response = await deps.transport.request<FreeBusyResponse>(accountId, {
            api: "calendar", method: "POST", path: "/freeBusy", readOnly: true, maxBytes: MAX_BYTES,
            expectedGeneration: account.generation,
            body: {
              timeMin: input.timeMin, timeMax: input.timeMax, timeZone: "UTC",
              calendarExpansionMax: 50, groupExpansionMax: 0,
              items: batch.map((index) => ({ id: result[index]!.calendarId })),
            },
          });
          for (const index of batch) {
            const source = result[index]!;
            const data = response?.calendars?.[source.calendarId];
            if (!data || (data.errors !== undefined && (!Array.isArray(data.errors) || data.errors.length > 0)) || !Array.isArray(data.busy)) {
              source.error = { code: "availability_unknown", message: "Google did not provide complete free/busy data for this selected calendar." };
              continue;
            }
            try {
              source.busy = mergeIntervals(normalizedIntervals(data.busy, min, max)).map(formatInterval);
              source.known = true;
            } catch {
              source.error = { code: "invalid_availability", message: "Google returned invalid busy intervals; availability is unknown." };
            }
          }
        } catch (error) {
          for (const index of batch) result[index]!.error = publicError(error);
        }
      });
    }
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
    while (next < jobs.length) await jobs[next++]!();
  }));
  return result;
}

export function createReadTools(deps: ServiceDependencies): ToolSpec[] {
  const cursors = new Cursors();
  return [
    tool("calendar_list_calendars", "Discover calendars accessible to one explicitly selected account. Returns at most 100 per page with query-bound continuation.", listCalendarsSchema, true, async (input) => {
      const account = await accountWithScopes(deps, input.accountId, [SCOPES.list]);
      const { cursor, ...query } = input;
      const binding = { tool: "calendars", accountGeneration: account.generation, ...query };
      const response = await deps.transport.request<Page<Calendar>>(account.id, {
        api: "calendar", method: "GET", path: "/users/me/calendarList", readOnly: true, expectedGeneration: account.generation,
        query: { maxResults: input.pageSize, pageToken: cursors.decode(binding, cursor), showHidden: true }, maxBytes: MAX_BYTES,
      });
      return {
        accountId: account.id, email: account.email,
        calendars: pageItems(response, input.pageSize).map((calendar) => ({ ...calendar, accountId: account.id, email: account.email })),
        complete: !response.nextPageToken, nextCursor: cursors.encode(binding, response.nextPageToken),
      };
    }),
    tool("calendar_list_events", "List or search events using query text in one selected calendar. Expanded occurrences require explicit offset-bearing timeMin/timeMax; singleEvents:false reads underlying masters and exceptions.", listEventsSchema, true, async (input) => {
      const account = await accountWithScopes(deps, input.accountId, [SCOPES.events]);
      const { cursor, ...query } = input;
      const binding = { tool: "events", accountGeneration: account.generation, ...query };
      const response = await deps.transport.request<Page<Event>>(account.id, {
        api: "calendar", method: "GET", path: eventsPath(input.calendarId), readOnly: true, expectedGeneration: account.generation,
        query: {
          maxResults: input.pageSize, pageToken: cursors.decode(binding, cursor),
          q: input.query, singleEvents: input.singleEvents, showDeleted: input.showDeleted,
          timeMin: input.timeMin, timeMax: input.timeMax, orderBy: input.singleEvents ? "startTime" : "updated",
        }, maxBytes: MAX_BYTES,
      });
      const events = pageItems(response, input.pageSize).map((event) => {
        assertEvent(event);
        return { ...event, accountId: account.id, email: account.email, calendarId: input.calendarId };
      });
      return { accountId: account.id, email: account.email, calendarId: input.calendarId, events, complete: !response.nextPageToken, nextCursor: cursors.encode(binding, response.nextPageToken) };
    }),
    tool("calendar_get_event", "Read an exact Google event or occurrence ID from an explicit account and calendar.", getEventSchema, true, async (input) => {
      const account = await accountWithScopes(deps, input.accountId, [SCOPES.events]);
      const event = await getEvent(deps, account, input.calendarId, input.eventId);
      return { accountId: account.id, email: account.email, calendarId: input.calendarId, event: { ...event, accountId: account.id, email: account.email } };
    }),
    tool("calendar_list_instances", "Ask Google to expand a recurring master inside explicit time bounds. Uses Google occurrence IDs and originalStartTime; never synthesizes IDs or splits a series.", instancesSchema, true, async (input) => {
      const account = await accountWithScopes(deps, input.accountId, [SCOPES.events]);
      const { cursor, ...query } = input;
      const binding = { tool: "instances", accountGeneration: account.generation, ...query };
      const response = await deps.transport.request<Page<Event>>(account.id, {
        api: "calendar", method: "GET", path: `${eventsPath(input.calendarId, input.eventId)}/instances`, readOnly: true, expectedGeneration: account.generation,
        query: {
          maxResults: input.pageSize, pageToken: cursors.decode(binding, cursor),
          timeMin: input.timeMin, timeMax: input.timeMax, showDeleted: input.showDeleted,
        }, maxBytes: MAX_BYTES,
      });
      const events = pageItems(response, input.pageSize).map((event) => {
        assertEvent(event);
        if (event.recurringEventId !== input.eventId || !event.originalStartTime) fail("invalid_google_response", "Google returned an unrelated instance.");
        return { ...event, accountId: account.id, email: account.email, calendarId: input.calendarId };
      });
      return { accountId: account.id, email: account.email, calendarId: input.calendarId, masterEventId: input.eventId, events, complete: !response.nextPageToken, nextCursor: cursors.encode(binding, response.nextPageToken) };
    }),
    tool("calendar_free_busy", "Read free/busy for explicit account/calendar pairs, batching at most 50 calendars per request with four concurrent requests. Missing or failed sources are unknown, never free. Maximum window: 31 days.", freeBusySchema, true, async (input) => {
      const sources = await gatherBusy(deps, input);
      return { timeMin: input.timeMin, timeMax: input.timeMax, complete: sources.every((source) => source.known), sources };
    }),
    tool("calendar_find_availability", "Find maximal common-free ranges of at least durationMinutes within a 31-day window across explicit account/calendar pairs. Returns no slots if any required calendar is unknown.", availabilitySchema, true, async (input) => {
      const sources = await gatherBusy(deps, input);
      if (sources.some((source) => !source.known)) {
        return { timeMin: input.timeMin, timeMax: input.timeMax, complete: false, slots: [], sources, reason: "At least one required source has unknown availability." };
      }
      const min = milliseconds(input.timeMin, true);
      const max = milliseconds(input.timeMax);
      const busy = mergeIntervals(sources.flatMap((source) => normalizedIntervals(source.busy, min, max)));
      const free: [number, number][] = [];
      let position = min;
      for (const [start, end] of busy) {
        if (start > position) free.push([position, start]);
        position = Math.max(position, end);
      }
      if (position < max) free.push([position, max]);
      const slots = free.filter(([start, end]) => end - start >= input.durationMinutes * 60_000);
      return {
        timeMin: input.timeMin, timeMax: input.timeMax, complete: true, truncated: slots.length > input.maxResults,
        slots: slots.slice(0, input.maxResults).map((range) => ({ ...formatInterval(range), availableMinutes: (range[1] - range[0]) / 60_000 })),
        sources,
      };
    }),
  ];
}
