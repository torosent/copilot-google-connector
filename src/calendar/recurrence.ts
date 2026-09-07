import { Temporal } from "@js-temporal/polyfill";
import { date, validZone, type Timing } from "./time.js";

const days = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
const frequencies = new Set(["SECONDLY", "MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const numericRules: Record<string, [number, number, boolean]> = {
  BYSECOND: [0, 60, true], BYMINUTE: [0, 59, true], BYHOUR: [0, 23, true],
  BYMONTHDAY: [-31, 31, false], BYYEARDAY: [-366, 366, false],
  BYWEEKNO: [-53, 53, false], BYMONTH: [1, 12, false], BYSETPOS: [-366, 366, false],
};

function basicDate(value: string): void {
  if (!/^\d{8}$/.test(value)) throw new Error("Recurrence dates must use YYYYMMDD.");
  date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`);
}

function basicDateTime(value: string, zone?: string): void {
  if (!/^\d{8}T\d{6}Z?$/.test(value)) throw new Error("Recurrence date-times must use YYYYMMDDTHHMMSS with UTC Z or a TZID.");
  if (Number(value.slice(13, 15)) > 59) throw new Error("Explicit leap-second recurrence dates are not supported.");
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}`;
  const plain = Temporal.PlainDateTime.from(iso, { overflow: "reject" });
  if (zone) {
    if (value.endsWith("Z")) throw new Error("TZID cannot accompany a UTC recurrence date-time.");
    plain.toZonedDateTime(zone, { disambiguation: "reject" });
  } else {
    if (!value.endsWith("Z")) throw new Error("A timed recurrence date requires UTC Z or an explicit TZID.");
    Temporal.Instant.from(`${iso}Z`);
  }
}

function rule(value: string, timing: Timing): void {
  const parts = new Map<string, string>();
  for (const part of value.split(";")) {
    const pair = /^([A-Z]+)=([A-Z0-9,+-]+)$/.exec(part);
    if (!pair?.[1] || !pair[2] || parts.has(pair[1])) throw new Error("RRULE parts must be valid, uppercase and unique.");
    parts.set(pair[1], pair[2]);
  }
  const freq = parts.get("FREQ");
  if (!freq || !frequencies.has(freq)) throw new Error("RRULE requires one supported FREQ.");
  if (parts.has("COUNT") && parts.has("UNTIL")) throw new Error("RRULE cannot contain both COUNT and UNTIL.");
  for (const [key, val] of parts) {
    if (key === "FREQ") continue;
    if (key === "COUNT" || key === "INTERVAL") {
      if (!/^[1-9]\d{0,8}$/.test(val)) throw new Error(`${key} must be a bounded positive integer.`);
    } else if (key === "UNTIL") {
      if (timing.type === "allDay") {
        basicDate(val);
        if (val < timing.startDate.replaceAll("-", "")) throw new Error("UNTIL cannot precede the first event date.");
      } else {
        basicDateTime(val);
        const iso = `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}T${val.slice(9, 11)}:${val.slice(11, 13)}:${val.slice(13, 15)}Z`;
        if (Temporal.Instant.compare(Temporal.Instant.from(iso), Temporal.Instant.from(timing.start)) < 0) throw new Error("UNTIL cannot precede the first event.");
      }
    } else if (key === "WKST") {
      if (!days.has(val)) throw new Error("WKST must be a weekday.");
    } else if (key === "BYDAY") {
      const values = val.split(",");
      if (new Set(values).size !== values.length) throw new Error("BYDAY entries must be unique.");
      for (const day of values) {
        const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(day);
        if (!match) throw new Error("Invalid BYDAY.");
        if (match[1] && (Number(match[1]) === 0 || Math.abs(Number(match[1])) > 53 || !["MONTHLY", "YEARLY"].includes(freq) || parts.has("BYWEEKNO"))) {
          throw new Error("Numeric BYDAY is only supported for monthly/yearly rules without BYWEEKNO.");
        }
      }
    } else if (numericRules[key]) {
      const [min, max, zeroAllowed] = numericRules[key];
      const values = val.split(",");
      if (new Set(values.map(Number)).size !== values.length) throw new Error(`${key} entries must be unique.`);
      for (const entry of values) {
        const number = Number(entry);
        if (!/^[+-]?\d{1,3}$/.test(entry) || number < min || number > max || (!zeroAllowed && number === 0)) throw new Error(`Invalid ${key} value.`);
      }
    } else {
      throw new Error(`Unsupported RRULE part: ${key}.`);
    }
  }
  if (parts.has("BYMONTHDAY") && freq === "WEEKLY") throw new Error("WEEKLY rules cannot use BYMONTHDAY.");
  if (parts.has("BYYEARDAY") && ["DAILY", "WEEKLY", "MONTHLY"].includes(freq)) throw new Error("This frequency cannot use BYYEARDAY.");
  if (parts.has("BYWEEKNO") && freq !== "YEARLY") throw new Error("BYWEEKNO requires YEARLY.");
  if (parts.has("BYSETPOS") && ![...parts.keys()].some((key) => key.startsWith("BY") && key !== "BYSETPOS")) throw new Error("BYSETPOS requires another BY rule.");
  if (timing.type === "allDay" && (["SECONDLY", "MINUTELY", "HOURLY"].includes(freq) || ["BYSECOND", "BYMINUTE", "BYHOUR"].some((key) => parts.has(key)))) {
    throw new Error("All-day recurrence cannot contain time-of-day rules.");
  }
}

export function validateRecurrence(lines: string[], timing: Timing): void {
  let rules = 0;
  for (const line of lines) {
    if (/[\r\n]/.test(line)) throw new Error("Each recurrence entry must be one line.");
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error("A recurrence entry must have a property and value.");
    const head = line.slice(0, colon).split(";");
    const name = head.shift();
    const value = line.slice(colon + 1);
    if (name === "RRULE") {
      if (head.length || ++rules > 1) throw new Error("Use a single RRULE without property parameters.");
      rule(value, timing);
      continue;
    }
    if (name !== "RDATE" && name !== "EXDATE") throw new Error("Only RRULE, RDATE and EXDATE are supported; DTSTART/DTEND must not be embedded.");
    const params = new Map<string, string>();
    for (const part of head) {
      const split = part.indexOf("=");
      const key = part.slice(0, split);
      const val = part.slice(split + 1);
      if (split < 1 || !val || !["TZID", "VALUE"].includes(key) || params.has(key)) throw new Error("Unsupported or duplicate recurrence property parameter.");
      params.set(key, val);
    }
    const entries = value.split(",");
    if (!value || entries.length > 1000 || new Set(entries).size !== entries.length) throw new Error("Recurrence dates must be nonempty, unique and bounded.");
    if (timing.type === "allDay") {
      if (params.get("VALUE") !== "DATE" || params.has("TZID")) throw new Error("All-day RDATE/EXDATE must use VALUE=DATE without TZID.");
      entries.forEach(basicDate);
    } else {
      if (params.has("VALUE") && params.get("VALUE") !== "DATE-TIME") throw new Error("Timed RDATE/EXDATE must use DATE-TIME values.");
      const zone = params.get("TZID");
      if (zone) validZone(zone);
      for (const entry of entries) basicDateTime(entry, zone);
    }
  }
  if (lines.length > 0 && !rules && !lines.some((line) => line.startsWith("RDATE"))) throw new Error("EXDATE alone does not define a recurring series.");
}
