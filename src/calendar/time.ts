import { Temporal } from "@js-temporal/polyfill";
import { ConnectorError } from "../core/errors.js";

export type Timing =
  | { type: "timed"; start: string; end: string; timeZone: string }
  | { type: "allDay"; startDate: string; endDate: string };

const offsetDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function validZone(value: string): void {
  if (!value || /^[+-]/.test(value)) throw new Error("Use a named IANA time zone.");
  new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
}

export function instant(value: string): Temporal.Instant {
  if (!offsetDateTime.test(value) || value.endsWith("-00:00")) throw new Error("A complete RFC3339 timestamp with a known explicit offset is required.");
  if (Number(value.slice(17, 19)) > 59) throw new Error("Leap-second timestamps are not supported and must not be silently normalized.");
  const plain = value.replace(/(?:Z|[+-]\d{2}:\d{2})$/, "");
  Temporal.PlainDateTime.from(plain, { overflow: "reject" });
  return Temporal.Instant.from(value);
}

export function date(value: string): Temporal.PlainDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Use an ISO calendar date.");
  return Temporal.PlainDate.from(value, { overflow: "reject" });
}

export function validateTiming(value: Timing): void {
  if (value.type === "allDay") {
    if (Temporal.PlainDate.compare(date(value.startDate), date(value.endDate)) >= 0) {
      throw new Error("All-day endDate is exclusive and must be later than startDate.");
    }
    return;
  }
  validZone(value.timeZone);
  const start = instant(value.start);
  const end = instant(value.end);
  // Temporal treats Z as an exact instant rather than an offset assertion.
  // Convert it to +00:00 so the supplied wall time must still match this zone.
  Temporal.ZonedDateTime.from(`${value.start.replace(/Z$/, "+00:00")}[${value.timeZone}]`, { offset: "reject", disambiguation: "reject" });
  Temporal.ZonedDateTime.from(`${value.end.replace(/Z$/, "+00:00")}[${value.timeZone}]`, { offset: "reject", disambiguation: "reject" });
  if (Temporal.Instant.compare(start, end) >= 0) throw new Error("The event end must be later than its start.");
}

export function validateWindow(timeMin: string, timeMax: string, maxDays?: number): void {
  const from = instant(timeMin);
  const to = instant(timeMax);
  if (Temporal.Instant.compare(from, to) >= 0) throw new Error("timeMax must be later than timeMin.");
  if (maxDays !== undefined && to.epochNanoseconds - from.epochNanoseconds > BigInt(maxDays) * 86_400_000_000_000n) {
    throw new Error(`The requested window must not exceed ${maxDays} days.`);
  }
}

export function googleTiming(timing: Timing): Record<string, unknown> {
  validateTiming(timing);
  return timing.type === "allDay"
    ? { start: { date: timing.startDate }, end: { date: timing.endDate } }
    : {
        start: { dateTime: timing.start, timeZone: timing.timeZone },
        end: { dateTime: timing.end, timeZone: timing.timeZone },
      };
}

export function existingTiming(event: Record<string, unknown>, calendarZone?: string): Timing {
  const start = event.start as Record<string, unknown> | undefined;
  const end = event.end as Record<string, unknown> | undefined;
  let timing: Timing;
  if (typeof start?.date === "string" && typeof end?.date === "string") {
    timing = { type: "allDay", startDate: start.date, endDate: end.date };
  } else if (typeof start?.dateTime === "string" && typeof end?.dateTime === "string") {
    const timeZone = typeof start.timeZone === "string" ? start.timeZone : calendarZone;
    if (!timeZone) throw new ConnectorError("unknown_event_time_zone", "The current event has no verifiable IANA time zone.");
    timing = { type: "timed", start: start.dateTime, end: end.dateTime, timeZone };
  } else {
    throw new ConnectorError("unknown_event_timing", "The current event has incomplete start/end information.");
  }
  try {
    validateTiming(timing);
    return timing;
  } catch {
    throw new ConnectorError("unknown_event_timing", "The current event timing cannot be safely interpreted. Supply an explicit supported timing.");
  }
}
