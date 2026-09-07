import { z } from "zod";
import { validateRecurrence } from "./recurrence.js";
import { instant, validateTiming, validateWindow } from "./time.js";

export const id = z.string().min(1).max(1024).refine((s) => s !== "*" && !/[\u0000-\u001f\u007f]/.test(s), "An explicit identifier without control characters is required.");
export const accountId = id.max(200);
export const pageSize = z.number().int().min(1).max(100).default(50);
export const cursor = z.string().min(1).max(16384).optional();
export const timestamp = z.string().max(64).superRefine((s, ctx) => {
  try { instant(s); } catch { ctx.addIssue({ code: "custom", message: "Use a valid RFC3339 timestamp with seconds and an explicit known offset." }); }
});
export const timing = z.discriminatedUnion("type", [
  z.object({ type: z.literal("timed"), start: timestamp, end: timestamp, timeZone: z.string().min(1).max(128) }).strict(),
  z.object({ type: z.literal("allDay"), startDate: z.string().max(10), endDate: z.string().max(10) }).strict(),
]).superRefine((value, ctx) => {
  try { validateTiming(value); } catch (error) { ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid event timing." }); }
});
export const email = z.email().max(320).transform((s) => s.toLowerCase());
export const attendee = z.object({
  email,
  displayName: z.string().max(256).refine((s) => !/[\u0000-\u001f\u007f]/.test(s)).optional(),
  optional: z.boolean().optional(),
}).strict();
export const attendees = z.array(attendee).max(200).refine((values) => new Set(values.map((value) => value.email)).size === values.length, "Attendee emails must be unique.");
export const recurrence = z.array(z.string().min(1).max(4096)).max(20);
const visibility = z.enum(["default", "public", "private"]);
const fields = {
  summary: z.string().min(1).max(1024),
  description: z.string().max(65536).optional(),
  location: z.string().max(4096).optional(),
  timing,
  eventType: z.literal("default").default("default"),
  visibility: visibility.default("private"),
  transparency: z.enum(["opaque", "transparent"]).default("opaque"),
  recurrence: recurrence.optional(),
  attendees: attendees.default([]),
};
export const eventInput = z.object(fields).strict().superRefine((value, ctx) => {
  try { validateRecurrence(value.recurrence ?? [], value.timing); } catch (error) { ctx.addIssue({ code: "custom", path: ["recurrence"], message: error instanceof Error ? error.message : "Invalid recurrence." }); }
});
const attendeeChange = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("add"), attendees }).strict(),
  z.object({ mode: z.literal("remove"), emails: z.array(email).min(1).max(200).refine((v) => new Set(v).size === v.length) }).strict(),
  z.object({ mode: z.literal("replace"), attendees }).strict(),
]);
export const changes = z.object({
  summary: fields.summary.optional(),
  description: fields.description,
  location: fields.location,
  timing: timing.optional(),
  visibility: visibility.optional(),
  transparency: z.enum(["opaque", "transparent"]).optional(),
  recurrence: recurrence.optional(),
  attendees: attendeeChange.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Supply at least one change.");
export const writeBase = {
  accountId,
  calendarId: id,
  requestId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  sendUpdates: z.enum(["all", "externalOnly", "none"]),
};
export const targetBase = { ...writeBase, eventId: id, scope: z.enum(["single", "series", "occurrence"]) };
export const createSchema = z.object({ ...writeBase, event: eventInput }).strict();
export const updateSchema = z.object({ ...targetBase, changes }).strict();
export const deleteSchema = z.object(targetBase).strict();
export const rsvpSchema = z.object({ ...targetBase, responseStatus: z.enum(["accepted", "declined", "tentative", "needsAction"]) }).strict();

export const listCalendarsSchema = z.object({ accountId, pageSize, cursor }).strict();
export const getEventSchema = z.object({ accountId, calendarId: id, eventId: id }).strict();
export const listEventsSchema = z.object({
  accountId, calendarId: id, pageSize, cursor,
  query: z.string().max(2048).optional(),
  singleEvents: z.boolean().default(true),
  showDeleted: z.boolean().default(false),
  timeMin: timestamp.optional(), timeMax: timestamp.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.singleEvents || value.timeMin || value.timeMax) && (!value.timeMin || !value.timeMax)) {
    ctx.addIssue({ code: "custom", message: "Expanded occurrence queries and filtered windows require both timeMin and timeMax." });
  } else if (value.timeMin && value.timeMax) {
    try { validateWindow(value.timeMin, value.timeMax); } catch { ctx.addIssue({ code: "custom", message: "timeMax must follow timeMin." }); }
  }
});
export const instancesSchema = z.object({
  accountId, calendarId: id, eventId: id, timeMin: timestamp, timeMax: timestamp,
  pageSize, cursor, showDeleted: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  try { validateWindow(value.timeMin, value.timeMax); } catch { ctx.addIssue({ code: "custom", message: "timeMax must follow timeMin." }); }
});
export const selection = z.array(z.object({ accountId, calendarId: id }).strict()).min(1).max(200)
  .refine((values) => new Set(values.map((v) => JSON.stringify([v.accountId, v.calendarId]))).size === values.length, "Select each account/calendar pair once.");
const availabilityBase = { calendars: selection, timeMin: timestamp, timeMax: timestamp };
function windowIssue(value: { timeMin: string; timeMax: string }, ctx: z.RefinementCtx): void {
  try { validateWindow(value.timeMin, value.timeMax, 31); } catch { ctx.addIssue({ code: "custom", message: "Availability requires an increasing window no longer than 31 days." }); }
}
export const freeBusySchema = z.object(availabilityBase).strict().superRefine(windowIssue);
export const availabilitySchema = z.object({
  ...availabilityBase, durationMinutes: z.number().int().min(1).max(1440), maxResults: pageSize,
}).strict().superRefine(windowIssue);
