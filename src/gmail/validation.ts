import { domainToASCII } from "node:url";
import { z } from "zod";
import { ConnectorError } from "../core/errors.js";
import { MAX_GOOGLE_RESPONSE_BYTES } from "../core/limits.js";
import type { Account, Accounts } from "../core/types.js";

export const LIMITS = {
  accounts: 10,
  pageSize: 100,
  pages: 3,
  searchMessages: 1_000,
  concurrency: 4,
  textBytes: 1_048_576,
  attachmentBytes: 5 * 1_048_576,
  messageHttpBytes: MAX_GOOGLE_RESPONSE_BYTES,
  threadHttpBytes: MAX_GOOGLE_RESPONSE_BYTES,
  metadataHttpBytes: 128 * 1_024,
  outputBytes: 3 * 1_048_576,
  mimeBytes: 2 * 1_048_576,
  threadMessages: 50,
  mimeParts: 200,
  threadParts: 500,
  mimeDepth: 12,
  headerBytes: 8_192,
  totalHeaderBytes: 65_536,
} as const;

export const READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const headerControls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const bodyControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

export function safeHeader(value: string, maxBytes: number): boolean {
  return !/[\ud800-\udfff]/u.test(value) && !headerControls.test(value) && Buffer.byteLength(value) <= maxBytes;
}

export function normalizeEmail(value: string): string | undefined {
  if (!safeHeader(value, 1_024)) return undefined;
  const pieces = value.split("@");
  if (pieces.length !== 2) return undefined;
  const [local, domain] = pieces as [string, string];
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return undefined;
  if (/[\s/\\?#%:@<>\[\]"(),;]/u.test(domain)) return undefined;
  const ascii = domainToASCII(domain).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined;
  const address = `${local}@${ascii}`;
  return Buffer.byteLength(address) <= 254 ? address : undefined;
}

export const accountIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
export const resourceIdSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);
export const partIdSchema = z.string().max(128).regex(/^\d*(?:\.\d+)*$/);
export const pageTokenSchema = z.string().min(1).max(4_096).refine((value) => safeHeader(value, 4_096), "Invalid page token.");
const subjectSchema = z.string().max(998).refine((value) => safeHeader(value, 4_096), "Subject contains controls or is too large.").transform((value) => value.normalize("NFC"));
const recipientSchema = z.object({
  email: z.string().max(1_024).refine((value) => normalizeEmail(value) !== undefined, "Use one valid email address (ASCII local part; IDNA domains supported).").transform((value) => normalizeEmail(value)!),
  name: z.string().max(256).refine((value) => safeHeader(value, 512), "Display name contains controls or is too large.").transform((value) => value.normalize("NFC")).optional(),
}).strict();

export const searchSchema = z.object({
  accountIds: z.array(accountIdSchema).min(1).max(LIMITS.accounts),
  query: z.string().max(4_096).refine((value) => safeHeader(value, 4_096), "Query contains controls or is too large."),
  pageSize: z.number().int().min(1).max(LIMITS.pageSize).default(50),
  maxPages: z.number().int().min(1).max(LIMITS.pages).default(1),
  continuations: z.array(z.object({
    accountId: accountIdSchema,
    queryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    pageToken: pageTokenSchema,
  }).strict()).max(LIMITS.accounts).default([]),
}).strict().superRefine((value, context) => {
  if (new Set(value.accountIds).size !== value.accountIds.length) context.addIssue({ code: "custom", message: "Duplicate accountIds are not allowed." });
  if (value.accountIds.length * value.pageSize * value.maxPages > LIMITS.searchMessages) context.addIssue({ code: "custom", message: "Reduce accounts, pageSize or maxPages: at most 1000 messages may be requested." });
  if (new Set(value.continuations.map((cursor) => cursor.accountId)).size !== value.continuations.length || value.continuations.some((cursor) => !value.accountIds.includes(cursor.accountId))) context.addIssue({ code: "custom", message: "Each continuation must belong to one explicitly selected account." });
});

export const messageSchema = z.object({ accountId: accountIdSchema, messageId: resourceIdSchema }).strict();
export const threadSchema = z.object({
  accountId: accountIdSchema,
  threadId: resourceIdSchema,
  maxMessages: z.number().int().min(1).max(LIMITS.threadMessages).default(20),
}).strict();
export const attachmentSchema = z.object({
  accountId: accountIdSchema,
  messageId: resourceIdSchema,
  attachmentId: resourceIdSchema.optional(),
  partId: partIdSchema.optional(),
}).strict().refine((value) => (value.attachmentId !== undefined) !== (value.partId !== undefined), "Supply exactly one attachmentId or partId.");
export const draftSchema = z.object({
  accountId: accountIdSchema,
  requestId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  to: z.array(recipientSchema).max(100).default([]),
  cc: z.array(recipientSchema).max(100).default([]),
  bcc: z.array(recipientSchema).max(100).default([]),
  subject: subjectSchema.optional(),
  text: z.string().max(LIMITS.textBytes).refine((value) => !/[\ud800-\udfff]/u.test(value) && !bodyControls.test(value) && Buffer.byteLength(value) <= LIMITS.textBytes, "Text contains controls or exceeds 1 MiB.").transform((value) => value.replace(/\r\n?/g, "\n")),
  replyToMessageId: resourceIdSchema.optional(),
}).strict().superRefine((value, context) => {
  const count = value.to.length + value.cc.length + value.bcc.length;
  if (count < 1 || count > 100) context.addIssue({ code: "custom", message: "Supply 1–100 explicit recipients across to, cc and bcc." });
  if (value.replyToMessageId === undefined && value.subject === undefined) context.addIssue({ code: "custom", message: "A non-reply draft requires a subject." });
});

export async function getAccount(accounts: Accounts, accountId: string, scopes: string[]): Promise<Account> {
  const account = await accounts.get(accountId);
  if (account.id !== accountId || !normalizeEmail(account.email) || !account.generation) throw new ConnectorError("invalid_account", "The selected account has invalid verified identity metadata.");
  requireScopes(account, scopes);
  return account;
}

export function requireScopes(account: Account, scopes: string[]): void {
  const missing = scopes.filter((scope) => !account.scopes.includes(scope));
  if (missing.length) throw new ConnectorError("missing_scopes", "Reauthorize this account with the required Gmail scopes using the account setup CLI.", false, { accountId: account.id, missingScopes: missing });
}

export function invalidResponse(): never {
  throw new ConnectorError("gmail_invalid_response", "Gmail returned an invalid or inconsistent response.");
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidResponse();
  return value as Record<string, unknown>;
}

export function resourceId(value: unknown): string {
  const parsed = resourceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : invalidResponse();
}

export function checkedSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalidResponse();
  return value;
}

export function checkOutput<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > LIMITS.outputBytes) throw new ConnectorError("gmail_output_limit", "The Gmail result exceeds the output limit. Read fewer messages.");
  return value;
}

export function inertText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "");
}

export function shortText(value: unknown, maxBytes: number): string {
  if (typeof value !== "string") return "";
  const text = inertText(value);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  return Buffer.from(text).subarray(0, maxBytes).toString("utf8").replace(/\ufffd$/u, "") + "…";
}
