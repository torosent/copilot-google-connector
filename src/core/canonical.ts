import { createHash } from "node:crypto";
import { ConnectorError } from "./errors.js";

export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new ConnectorError("invalid_intent", "An operation must contain only JSON values.");
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
