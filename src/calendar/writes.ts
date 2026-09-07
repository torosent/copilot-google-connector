import type { z } from "zod";
import { digest } from "../core/canonical.js";
import { ConnectorError } from "../core/errors.js";
import type { Account, MutationPlan, PrivateProvenance, ServiceDependencies, ToolSpec } from "../core/types.js";
import {
  accountWithScopes, assertEvent, eventsPath, fail, getEvent, MAX_BYTES, MAX_PAGES,
  ownPrimary, pageItems, SCOPES, selectedCalendar, tool, type Calendar, type Event, type Page,
} from "./common.js";
import { validateRecurrence } from "./recurrence.js";
import { createSchema, deleteSchema, rsvpSchema, updateSchema } from "./schemas.js";
import { date, existingTiming, googleTiming, instant } from "./time.js";

type Dependencies = ServiceDependencies & { provenance: PrivateProvenance };
type CreateInput = z.infer<typeof createSchema>;
type UpdateInput = z.infer<typeof updateSchema>;
type TargetInput = z.infer<typeof deleteSchema>;
type Attendee = Record<string, unknown> & { email: string };
type Target = {
  current: Event; etag: string; master?: Event;
  recurrence: Record<string, unknown>;
};
type ProvenanceResult = {
  provenanceRecorded: boolean;
  provenanceWarning?: { code: string; message: string };
};
const MARKER = "copilotConnectorOperation";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function organizerIsAccount(event: Event, account: Account): boolean {
  const organizer = record(event.organizer);
  return organizer?.self === true && typeof organizer.email === "string" && organizer.email.toLowerCase() === account.email.toLowerCase();
}

function etag(event: Event): string {
  if (typeof event.etag !== "string" || !event.etag || event.etag.length > 1024 || /[\r\n]/.test(event.etag)) {
    fail("missing_event_etag", "Google did not supply an exact event ETag; the write cannot be safely prepared.");
  }
  return event.etag;
}

function assertDefaultEvent(event: Event): void {
  if (event.eventType !== "default" || ["focusTimeProperties", "outOfOfficeProperties", "workingLocationProperties", "birthdayProperties"].some((key) => event[key] !== undefined)) {
    fail("unsupported_event_type", "Only default Calendar events are supported. Special events with automatic or unknown side effects cannot be edited.");
  }
  if (event.status === "cancelled") fail("cancelled_event", "This Google event/occurrence is cancelled. Restoring cancelled occurrences is not supported.");
  if (event.locked === true) fail("locked_event", "Google marks this event as locked.");
  const organizer = record(event.organizer);
  if (typeof organizer?.email !== "string" || !organizer.email || /[\u0000-\u0020\u007f]/.test(organizer.email)) {
    fail("unknown_organizer", "Google did not provide the organizer identity needed to preview this event's effects.");
  }
}

function fullAttendees(event: Event, account: Account): Attendee[] {
  if (event.attendeesOmitted === true || (event.guestsCanSeeOtherGuests === false && !organizerIsAccount(event, account))) {
    fail("incomplete_attendees", "Google hides or omits participants on this event. An exact attendee/effect preview cannot be established.");
  }
  if (event.attendees !== undefined && !Array.isArray(event.attendees)) fail("incomplete_attendees", "Google returned an invalid attendee list.");
  const attendees = event.attendees ?? [];
  if (!Array.isArray(attendees) || attendees.length > 200) fail("attendee_limit", "This event exceeds the supported complete-attendee limit of 200.");
  const emails = new Set<string>();
  return attendees.map((value: unknown) => {
    const attendee = record(value);
    if (!attendee || typeof attendee.email !== "string" || !attendee.email || /[\u0000-\u0020\u007f]/.test(attendee.email) || emails.has(attendee.email.toLowerCase())) {
      fail("incomplete_attendees", "A participant's exact unique email identity is unavailable.");
    }
    emails.add(attendee.email.toLowerCase());
    return structuredClone(attendee) as Attendee;
  });
}

export function deterministicEventId(accountId: string, calendarId: string, requestId: string): string {
  // Hex is a subset of Google's base32hex alphabet (0-9, a-v).
  return `gc${digest({ v: 1, accountId, calendarId, requestId })}`;
}

function safePrivateState(event: Event, account: Account, calendar: Calendar): boolean {
  if (!ownPrimary(account, calendar) || event.eventType !== "default" || event.status === "cancelled"
    || event.visibility !== "private" || !organizerIsAccount(event, account)
    || event.recurringEventId || (Array.isArray(event.recurrence) && event.recurrence.length > 0)
    || (event.recurrence !== undefined && !Array.isArray(event.recurrence))
    || event.attendeesOmitted === true || event.guestsCanSeeOtherGuests === false
    || event.endTimeUnspecified === true || event.anyoneCanAddSelf === true
    || ["conferenceData", "attachments", "focusTimeProperties", "outOfOfficeProperties", "workingLocationProperties", "birthdayProperties"].some((key) => event[key] !== undefined)) return false;
  try {
    return fullAttendees(event, account).length === 0;
  } catch {
    return false;
  }
}

export function notificationEffects(sendUpdates: TargetInput["sendUpdates"]): Record<string, unknown> {
  return {
    sendUpdates,
    requestedDelivery: {
      all: "Request updates to all guests.",
      externalOnly: "Request updates only to guests using non-Google calendar services. Email domain alone does not prove which guests are external.",
      none: "Request no guest update emails; guests' copies may not synchronize and Google may still send some messages.",
    }[sendUpdates],
    limitation: "Google controls actual delivery. This setting is not a guarantee of notification suppression or receipt; RSVP may notify the organizer.",
  };
}

function attendeeEffects(before: Attendee[], after: Attendee[]): Record<string, unknown> {
  const oldEmails = new Set(before.map((item) => item.email.toLowerCase()));
  const newEmails = new Set(after.map((item) => item.email.toLowerCase()));
  return {
    complete: true,
    current: before,
    removed: before.filter((item) => !newEmails.has(item.email.toLowerCase())),
    added: after.filter((item) => !oldEmails.has(item.email.toLowerCase())),
    after,
    potentiallyAffected: [...new Map([...before, ...after].map((item) => [item.email.toLowerCase(), item])).values()],
  };
}

function applyAttendeeChange(before: Attendee[], change: NonNullable<UpdateInput["changes"]["attendees"]>): Attendee[] {
  const old = new Map(before.map((item) => [item.email.toLowerCase(), item]));
  if (change.mode === "remove") {
    const removed = new Set(change.emails);
    if (change.emails.some((email) => !old.has(email))) fail("unknown_attendee", "An attendee selected for removal is not on the current event.");
    return before.filter((item) => !removed.has(item.email.toLowerCase()));
  }
  const supplied = change.attendees.map((item): Attendee => {
    const existing = old.get(item.email);
    if (change.mode === "add" && existing) fail("duplicate_attendee", "An attendee selected for addition already exists; use replace to update attendee metadata.");
    return existing ? { ...existing, ...item } : { ...item, responseStatus: "needsAction" };
  });
  const result = change.mode === "add" ? [...before, ...supplied] : supplied;
  if (result.length > 200) fail("attendee_limit", "The resulting event would exceed the supported 200-attendee limit.");
  return result;
}

async function scanSeries(deps: Dependencies, account: Account, calendarId: string, master: Event): Promise<void> {
  if (!master.iCalUID || typeof master.iCalUID !== "string") fail("unknown_series_identity", "The recurring master has no iCalUID for inspecting its persisted exceptions.");
  let pageToken: string | undefined;
  let foundMaster = false;
  const seenTokens = new Set<string>();
  const seenEvents = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await deps.transport.request<Page<Event>>(account.id, {
      api: "calendar", method: "GET", path: eventsPath(calendarId), readOnly: true, expectedGeneration: account.generation, maxBytes: MAX_BYTES,
      query: { iCalUID: master.iCalUID, singleEvents: false, showDeleted: true, showHiddenInvitations: true, maxResults: 100, pageToken },
    });
    for (const event of pageItems(response)) {
      assertEvent(event);
      if (seenEvents.has(event.id)) fail("series_changed", "The series changed while its pages were being read. Review a new request.");
      seenEvents.add(event.id);
      if (event.id === master.id) {
        if (event.etag !== master.etag) fail("series_changed", "The recurring master changed during preparation. Review a new request.");
        foundMaster = true;
      } else if (event.recurringEventId === master.id) {
        fail("series_has_exceptions", "Whole-series writes with existing moved, modified or cancelled exceptions are not supported: exact effects on those copies cannot be guaranteed. Select a specific occurrence instead.");
      } else {
        fail("unknown_series_effects", "Google returned another resource for this series identity; exact series effects cannot be established.");
      }
    }
    pageToken = response.nextPageToken;
    if (!pageToken) {
      if (!foundMaster) fail("unknown_series_effects", "The exception scan did not return the exact recurring master.");
      return;
    }
    if (seenTokens.has(pageToken)) fail("pagination_cycle", "Google repeated a series page token.");
    seenTokens.add(pageToken);
  }
  fail("series_scan_limit", "The complete exception scan exceeded 50 pages. No write was prepared.");
}

function originalOccurrence(event: Event): Record<string, unknown> {
  const original = record(event.originalStartTime);
  try {
    if (typeof original?.date === "string" && original.dateTime === undefined) date(original.date);
    else if (typeof original?.dateTime === "string" && original.date === undefined) instant(original.dateTime);
    else throw new Error();
  } catch {
    fail("unknown_occurrence", "Google did not provide a valid exact originalStartTime for this occurrence.");
  }
  return original!;
}

async function resolveTarget(deps: Dependencies, account: Account, calendar: Calendar, input: TargetInput): Promise<Target> {
  const current = await getEvent(deps, account, calendar.id, input.eventId);
  assertDefaultEvent(current);
  existingTiming(current, calendar.timeZone);
  const currentETag = etag(current);
  const recurring = Array.isArray(current.recurrence) && current.recurrence.length > 0;
  if (current.recurrence !== undefined && !Array.isArray(current.recurrence)) fail("unknown_recurrence", "Google returned invalid recurrence metadata.");
  if (input.scope === "single") {
    if (current.recurringEventId || recurring) fail("recurrence_scope_mismatch", "scope:single only targets a nonrecurring event. Use the exact series or occurrence scope.");
    return { current, etag: currentETag, recurrence: { scope: "single" } };
  }
  if (input.scope === "series") {
    if (current.recurringEventId || !recurring) fail("recurrence_scope_mismatch", "scope:series requires the actual recurring master ID, never an occurrence ID.");
    await scanSeries(deps, account, calendar.id, current);
    return {
      current, etag: currentETag, master: current,
      recurrence: {
        scope: "series", masterEventId: current.id, masterETag: currentETag, knownPersistedExceptions: [],
        effects: "Changes apply to the entire recurring series, not this-and-following. Google expands the recurrence.",
        preconditionLimit: "The bounded exception scan is rechecked before dispatch, but is not an atomic series snapshot. If-Match protects only the master; concurrent new exceptions cannot be atomically locked.",
      },
    };
  }
  if (!current.recurringEventId || recurring || current.recurringEventId === current.id) {
    fail("recurrence_scope_mismatch", "scope:occurrence requires an exact Google occurrence ID with recurringEventId and originalStartTime.");
  }
  const originalStartTime = originalOccurrence(current);
  const master = await getEvent(deps, account, calendar.id, current.recurringEventId);
  assertDefaultEvent(master);
  if (master.recurringEventId || !Array.isArray(master.recurrence) || master.recurrence.length === 0) fail("unknown_recurring_master", "The occurrence's Google master is not a verifiable recurring series.");
  return {
    current, etag: currentETag, master,
    recurrence: {
      scope: "occurrence", masterEventId: master.id, masterETag: etag(master),
      occurrenceId: current.id, originalStartTime,
      effects: "Only this exact Google occurrence is mutated, including when it has moved from originalStartTime.",
      preconditionLimit: "If-Match protects the occurrence. The master's ETag is rechecked separately immediately before dispatch; the two resources are not atomically locked.",
    },
  };
}

async function recheck(deps: Dependencies, account: Account, calendar: Calendar, target: Target, scope: TargetInput["scope"]): Promise<void> {
  if (!target.master) return;
  if (scope === "series") {
    await scanSeries(deps, account, calendar.id, target.master);
  } else {
    const master = await getEvent(deps, account, calendar.id, target.master.id);
    if (etag(master) !== target.master.etag) fail("series_changed", "The recurring master changed since approval. Read the event and prepare a new request.");
  }
}

async function context(deps: Dependencies, accountId: string, calendarId: string): Promise<{ account: Account; calendar: Calendar }> {
  const account = await accountWithScopes(deps, accountId, [SCOPES.events, SCOPES.list]);
  const calendar = await selectedCalendar(deps, account, calendarId);
  if (calendar.accessRole !== "owner" && calendar.accessRole !== "writer") fail("calendar_read_only", "The selected account cannot write this calendar.");
  return { account, calendar };
}

function previewBase(account: Account, calendar: Calendar, input: { calendarId: string; sendUpdates: TargetInput["sendUpdates"] }): Record<string, unknown> {
  return {
    accountId: account.id, email: account.email, calendarId: calendar.id, requestedCalendarId: input.calendarId,
    calendar: { id: calendar.id, summary: calendar.summary, primary: calendar.primary === true, accessRole: calendar.accessRole, timeZone: calendar.timeZone },
    notifications: notificationEffects(input.sendUpdates),
  };
}

async function remember(deps: Dependencies, account: Account, calendar: Calendar, event: Event, qualifyingOperation: boolean): Promise<ProvenanceResult> {
  try {
    if (qualifyingOperation && safePrivateState(event, account, calendar) && event.etag) {
      await deps.provenance.record(account.id, calendar.id, event.id, etag(event));
      return { provenanceRecorded: true };
    }
    await deps.provenance.forget(account.id, calendar.id, event.id);
    return { provenanceRecorded: false };
  } catch {
    return {
      provenanceRecorded: false,
      provenanceWarning: {
        code: "private_provenance_maintenance_failed",
        message: "The Google mutation succeeded, but local private-event provenance could not be maintained. Do not retry the Google mutation. Later private edits must require approval until local state is repaired.",
      },
    };
  }
}

async function mutateEvent(
  deps: Dependencies, account: Account, calendar: Calendar, target: Target,
  input: TargetInput, body: Record<string, unknown>, kind: string,
): Promise<Event> {
  await recheck(deps, account, calendar, target, input.scope);
  try {
    const event = await deps.transport.request<unknown>(account.id, {
      api: "calendar", method: "PATCH", path: eventsPath(calendar.id, target.current.id),
      query: { sendUpdates: input.sendUpdates }, body, headers: { "If-Match": target.etag },
      expectedGeneration: account.generation, maxBytes: MAX_BYTES,
    });
    return mutationResponse(event, target.current.id, kind);
  } catch (error) {
    return preconditionError(error);
  }
}

function mutationResponse(value: unknown, eventId: string, kind: string): Event {
  if (!record(value) || (value as Event).id !== eventId || typeof (value as Event).etag !== "string" || !(value as Event).etag) {
    throw new ConnectorError("invalid_mutation_response", `Google may have completed the ${kind}, but did not return its exact event identity/ETag. Inspect the same event before retrying.`, false, { outcomeUnknown: true });
  }
  return value as Event;
}

function preconditionError(error: unknown): never {
  if (error instanceof ConnectorError && error.details?.httpStatus === 412) {
    throw new ConnectorError("etag_conflict", "The event changed after preparation. No update was applied; read it again and prepare a new request and approval.", false, { httpStatus: 412, outcomeUnknown: false });
  }
  throw error;
}

async function submit(
  deps: Dependencies, kind: string, input: { accountId: string; requestId: string },
  prepare: () => Promise<MutationPlan>,
): Promise<unknown> {
  const account = await deps.accounts.get(input.accountId);
  const result = await deps.operations.submit(input.accountId, input.requestId, { v: 1, kind, ...input }, prepare);
  return { ...(record(result) ?? { result }), accountId: account.id, email: account.email };
}

async function prepareCreate(deps: Dependencies, input: CreateInput): Promise<MutationPlan> {
  const { account, calendar } = await context(deps, input.accountId, input.calendarId);
  const { timing, attendees: requestedAttendees, ...fields } = input.event;
  const attendees: Attendee[] = requestedAttendees.map((attendee) => ({ ...attendee, responseStatus: "needsAction" }));
  const eventId = deterministicEventId(account.id, calendar.id, input.requestId);
  const marker = digest({ v: 1, accountId: account.id, calendarId: calendar.id, intent: input });
  const body = {
    ...fields, ...googleTiming(timing), attendees, id: eventId,
    extendedProperties: { private: { [MARKER]: marker } },
  };
  const privateWrite = ownPrimary(account, calendar) && fields.eventType === "default" && fields.visibility === "private"
    && attendees.length === 0 && input.sendUpdates === "none";
  return {
    kind: "calendar_create_event", accountId: account.id, accountGeneration: account.generation, requiresApproval: !privateWrite,
    preview: {
      ...previewBase(account, calendar, input), before: null, after: body,
      attendees: attendeeEffects([], attendees),
      recurrence: { scope: fields.recurrence?.length ? "series" : "single", after: fields.recurrence ?? [], effects: "Google creates and expands this rule; no occurrence IDs are locally generated." },
      privateException: privateWrite,
    },
    execute: async () => {
      let event: Event;
      let reconciled = false;
      try {
        const response = await deps.transport.request<unknown>(account.id, {
          api: "calendar", method: "POST", path: eventsPath(calendar.id),
          query: { sendUpdates: input.sendUpdates }, body, expectedGeneration: account.generation, maxBytes: MAX_BYTES,
        });
        event = mutationResponse(response, eventId, "create");
      } catch (error) {
        if (!(error instanceof ConnectorError) || (error.details?.httpStatus !== 409 && error.details?.outcomeUnknown !== true)) throw error;
        let existing: Event;
        try {
          existing = await getEvent(deps, account, calendar.id, eventId);
        } catch {
          throw error;
        }
        const privateProperties = record(record(existing.extendedProperties)?.private);
        if (privateProperties?.[MARKER] !== marker) {
          if (error.details?.outcomeUnknown === true && error.details?.httpStatus !== 409) throw error;
          fail("create_id_conflict", "An event exists at the deterministic ID but does not carry this operation's exact private marker. It was not adopted or overwritten.");
        }
        event = mutationResponse(existing, eventId, "create reconciliation");
        reconciled = true;
      }
      const provenance = await remember(deps, account, calendar, event, privateWrite && !reconciled && !fields.recurrence?.length);
      return {
        accountId: account.id, email: account.email, calendarId: calendar.id, eventId, etag: event.etag,
        event, reconciled, ...provenance,
      };
    },
  };
}

async function prepareUpdate(deps: Dependencies, input: UpdateInput): Promise<MutationPlan> {
  const { account, calendar } = await context(deps, input.accountId, input.calendarId);
  const target = await resolveTarget(deps, account, calendar, input);
  const beforeAttendees = fullAttendees(target.current, account);
  if (input.changes.recurrence !== undefined && input.scope !== "series") {
    fail("recurrence_scope_mismatch", "Recurrence replacement/removal is only supported on an explicitly selected recurring series, never a single occurrence.");
  }
  const { timing, attendees: attendeeChange, ...fields } = input.changes;
  const afterAttendees = attendeeChange ? applyAttendeeChange(beforeAttendees, attendeeChange) : beforeAttendees;
  const desiredTiming = timing ? googleTiming(timing) : undefined;
  const timingPatch = desiredTiming ? Object.fromEntries(Object.entries(desiredTiming).map(([key, value]) => [
    key,
    { ...(timing!.type === "allDay" ? { dateTime: null, timeZone: null } : { date: null }), ...value as Record<string, unknown> },
  ])) : undefined;
  const body: Record<string, unknown> = {
    ...fields,
    ...timingPatch,
    ...(attendeeChange ? { attendees: afterAttendees } : {}),
  };
  const after = { ...structuredClone(target.current), ...structuredClone(body), ...desiredTiming } as Event;
  if (input.changes.recurrence !== undefined || (timing && target.current.recurrence?.length)) {
    try {
      validateRecurrence(after.recurrence ?? [], timing ?? existingTiming(after, calendar.timeZone));
    } catch (error) {
      fail("invalid_recurrence", error instanceof Error ? error.message : "The proposed recurrence/timing combination is invalid.");
    }
  }
  const privateWrite = input.scope === "single" && input.sendUpdates === "none"
    && safePrivateState(target.current, account, calendar) && safePrivateState(after, account, calendar)
    && await deps.provenance.matches(account.id, calendar.id, target.current.id, target.etag);
  return {
    kind: "calendar_update_event", accountId: account.id, accountGeneration: account.generation, requiresApproval: !privateWrite,
    preview: {
      ...previewBase(account, calendar, input), eventId: target.current.id,
      before: target.current, after, patch: body, ifMatch: target.etag,
      attendees: attendeeEffects(beforeAttendees, afterAttendees), recurrence: target.recurrence, privateException: privateWrite,
    },
    execute: async () => {
      const event = await mutateEvent(deps, account, calendar, target, input, body, "update");
      const provenance = await remember(deps, account, calendar, event, privateWrite);
      return { accountId: account.id, email: account.email, calendarId: calendar.id, eventId: event.id, etag: event.etag, event, ...provenance };
    },
  };
}

async function prepareDelete(deps: Dependencies, input: TargetInput): Promise<MutationPlan> {
  const { account, calendar } = await context(deps, input.accountId, input.calendarId);
  const target = await resolveTarget(deps, account, calendar, input);
  const attendees = fullAttendees(target.current, account);
  return {
    kind: "calendar_delete_event", accountId: account.id, accountGeneration: account.generation, requiresApproval: true,
    preview: {
      ...previewBase(account, calendar, input), eventId: target.current.id,
      before: target.current, after: null, ifMatch: target.etag,
      attendees: attendeeEffects(attendees, []), recurrence: target.recurrence, privateException: false,
    },
    execute: async () => {
      await recheck(deps, account, calendar, target, input.scope);
      try {
        await deps.transport.request(account.id, {
          api: "calendar", method: "DELETE", path: eventsPath(calendar.id, target.current.id),
          query: { sendUpdates: input.sendUpdates }, headers: { "If-Match": target.etag }, expectedGeneration: account.generation,
        });
      } catch (error) {
        preconditionError(error);
      }
      const provenance = await remember(deps, account, calendar, target.current, false);
      return { accountId: account.id, email: account.email, calendarId: calendar.id, eventId: target.current.id, status: "deleted", ...provenance };
    },
  };
}

async function prepareRsvp(deps: Dependencies, input: z.infer<typeof rsvpSchema>): Promise<MutationPlan> {
  const { account, calendar } = await context(deps, input.accountId, input.calendarId);
  if (!ownPrimary(account, calendar)) fail("rsvp_not_own_primary", "Self-RSVP is restricted to this account's proven own primary calendar copy. A shared calendar's self flag is not your identity.");
  const target = await resolveTarget(deps, account, calendar, input);
  const attendees = fullAttendees(target.current, account);
  const self = attendees.find((attendee) => attendee.email.toLowerCase() === account.email.toLowerCase());
  if (!self || self.self !== true || organizerIsAccount(target.current, account)) {
    fail("rsvp_identity_unproven", "The selected copy must identify the verified account email as the self attendee, not the organizer. Other attendees' responses cannot be changed.");
  }
  const afterAttendees = attendees.map((attendee) => attendee === self ? { ...attendee, responseStatus: input.responseStatus } : attendee);
  const body = { attendeesOmitted: true, attendees: [{ email: self.email, responseStatus: input.responseStatus }] };
  return {
    kind: "calendar_rsvp", accountId: account.id, accountGeneration: account.generation, requiresApproval: true,
    preview: {
      ...previewBase(account, calendar, input), eventId: target.current.id,
      before: target.current, after: { ...target.current, attendees: afterAttendees },
      patch: body, ifMatch: target.etag, attendees: attendeeEffects(attendees, afterAttendees),
      recurrence: target.recurrence, privateException: false,
      participantOnly: "attendeesOmitted:true is Google's documented participant-only update semantics. Only the proven self attendee's responseStatus is submitted; this is not replacement of the complete attendee list.",
    },
    execute: async () => {
      const event = await mutateEvent(deps, account, calendar, target, input, body, "RSVP");
      const provenance = await remember(deps, account, calendar, event, false);
      return { accountId: account.id, email: account.email, calendarId: calendar.id, eventId: event.id, etag: event.etag, responseStatus: input.responseStatus, event, ...provenance };
    },
  };
}

export function createWriteTools(deps: Dependencies): ToolSpec[] {
  return [
    tool("calendar_create_event", "Create a default event with timed or exclusive-end all-day dates, attendees and optional validated recurrence. Requires requestId and explicit sendUpdates. Only private, guest-free creates on the account's own primary calendar with sendUpdates:none bypass approval; recurring edits still require approval.", createSchema, false,
      async (input) => submit(deps, "calendar_create_event", input, () => prepareCreate(deps, input))),
    tool("calendar_update_event", "Patch one exact default event, recurring series or Google occurrence. Explicit attendee add/remove/replace preserves existing responses; arbitrary responseStatus/status inputs are not accepted. Uses ETags and human approval except proven continuous connector-private edits. Series with persisted exceptions fail closed.", updateSchema, false,
      async (input) => submit(deps, "calendar_update_event", input, () => prepareUpdate(deps, input))),
    tool("calendar_delete_event", "Delete one exact event, occurrence or series after human approval. requestId, recurrence scope and sendUpdates are mandatory. Uses If-Match; no this-and-following fallback.", deleteSchema, false,
      async (input) => submit(deps, "calendar_delete_event", input, () => prepareDelete(deps, input))),
    tool("calendar_rsvp", "Approve a participant-only self-RSVP on the verified account's own primary-calendar copy. Requires exact self email identity, complete known attendees, recurrence scope, sendUpdates and human approval. Cannot alter another person's response.", rsvpSchema, false,
      async (input) => submit(deps, "calendar_rsvp", input, () => prepareRsvp(deps, input))),
  ];
}
