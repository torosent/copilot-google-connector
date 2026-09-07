import { simpleParser, type ParsedMail } from "mailparser";
import { ConnectorError } from "../core/errors.js";
import { checkedSize, inertText, invalidResponse, LIMITS, partIdSchema, record, resourceId, shortText } from "./validation.js";

export interface Header { name: string; value: string }
export interface Part {
  partId: string;
  mimeType: string;
  filename: string;
  headers: Header[];
  size: number;
  data?: string;
  attachmentId?: string;
  parts: Part[];
}
export interface Message {
  id: string;
  threadId: string;
  snippet: string;
  internalDate?: string;
  payload: Part;
}
export interface MimeBudget { parts: number; decodedBytes: number; headerBytes: number; maxParts: number }

export function mimeBudget(thread = false): MimeBudget {
  return { parts: 0, decodedBytes: 0, headerBytes: 0, maxParts: thread ? LIMITS.threadParts : LIMITS.mimeParts };
}

function mimeLimit(): never {
  throw new ConnectorError("gmail_mime_limit", "The message or thread exceeds MIME nesting, part, header or decoded-text limits. Read a smaller message.");
}

export function readHeaders(value: unknown, budget?: MimeBudget): Header[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) return mimeLimit();
  let bytes = 0;
  const result = value.map((entry) => {
    const header = record(entry);
    if (typeof header.name !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(header.name) || typeof header.value !== "string") return invalidResponse();
    if (Buffer.byteLength(header.value) > LIMITS.headerBytes) return mimeLimit();
    const unfolded = header.value.replace(/\r?\n[ \t]+/g, " ");
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/u.test(unfolded)) return invalidResponse();
    bytes += Buffer.byteLength(header.name) + Buffer.byteLength(unfolded);
    return { name: header.name.toLowerCase(), value: unfolded };
  });
  if (bytes > LIMITS.totalHeaderBytes) return mimeLimit();
  if (budget) {
    budget.headerBytes += bytes;
    if (budget.headerBytes > LIMITS.totalHeaderBytes * (budget.maxParts === LIMITS.threadParts ? 4 : 1)) return mimeLimit();
  }
  return result;
}

export function headerValue(headers: Header[], name: string): string | undefined {
  return headers.find((header) => header.name === name)?.value;
}

export function decodedLength(data: string, limit: number): number {
  if (data.length > Math.ceil(limit / 3) * 4 + 2) return mimeLimit();
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(data)) return invalidResponse();
  const unpadded = data.replace(/=+$/, "");
  if (unpadded.length % 4 === 1 || (data.includes("=") && data.length % 4 !== 0)) return invalidResponse();
  const bytes = Math.floor(unpadded.length * 3 / 4);
  if (bytes > limit) return mimeLimit();
  return bytes;
}

export function decodeBody(data: string, limit: number): Buffer {
  decodedLength(data, limit);
  const buffer = Buffer.from(data, "base64url");
  if (buffer.toString("base64url") !== data.replace(/=+$/, "")) return invalidResponse();
  return buffer;
}

function isBody(part: Part): boolean {
  return !part.filename && !/^attachment(?:;|$)/i.test(headerValue(part.headers, "content-disposition")?.trim() ?? "")
    && (part.mimeType === "text/plain" || part.mimeType === "text/html");
}

function isOpaque(part: Part): boolean {
  return (part.mimeType === "message/rfc822" && !part.parts.length) || !!part.filename
    || /^attachment(?:;|$)/i.test(headerValue(part.headers, "content-disposition")?.trim() ?? "");
}

export function bodyParts(part: Part): Part[] {
  if (isOpaque(part)) return [];
  if (part.parts.length) return part.parts.flatMap(bodyParts);
  return isBody(part) ? [part] : [];
}

function inspectPart(value: unknown, budget: MimeBudget, depth: number): Part {
  if (depth > LIMITS.mimeDepth || ++budget.parts > budget.maxParts) return mimeLimit();
  const input = record(value);
  const headers = readHeaders(input.headers, budget);
  if (typeof input.mimeType !== "string") return invalidResponse();
  const mimeType = input.mimeType.toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType) || mimeType.length > 128) return invalidResponse();
  const partId = partIdSchema.safeParse(input.partId ?? "");
  if (!partId.success || (input.filename !== undefined && (typeof input.filename !== "string" || Buffer.byteLength(input.filename) > 4_096))) return invalidResponse();
  const body = record(input.body ?? {});
  const size = checkedSize(body.size ?? 0);
  if (body.data !== undefined && typeof body.data !== "string") return invalidResponse();
  if (typeof body.data === "string" && body.data.length > Math.ceil(LIMITS.attachmentBytes / 3) * 4) return mimeLimit();
  const attachmentId = body.attachmentId !== undefined ? resourceId(body.attachmentId) : undefined;
  const data = body.data === "" && size > 0 && attachmentId !== undefined ? undefined : body.data;
  const part: Part = {
    partId: partId.data,
    mimeType,
    filename: typeof input.filename === "string" ? input.filename : "",
    headers, size,
    ...(data !== undefined ? { data: data as string } : {}),
    ...(attachmentId !== undefined ? { attachmentId } : {}),
    parts: [],
  };
  if (input.parts !== undefined) {
    if (!Array.isArray(input.parts) || input.parts.length > LIMITS.mimeParts) return mimeLimit();
    part.parts = input.parts.map((child) => inspectPart(child, budget, depth + 1));
  }
  if (part.parts.length && !mimeType.startsWith("multipart/") && mimeType !== "message/rfc822") return invalidResponse();
  if (isBody(part) && part.data !== undefined) {
    const bytes = decodedLength(part.data, LIMITS.textBytes);
    if (bytes !== part.size) return invalidResponse();
    budget.decodedBytes += bytes;
    if (budget.decodedBytes > LIMITS.textBytes) return mimeLimit();
  }
  return part;
}

export function inspectMessage(value: unknown, budget: MimeBudget, expectedId?: string, expectedThreadId?: string): Message {
  const input = record(value);
  const id = resourceId(input.id);
  const threadId = resourceId(input.threadId);
  if ((expectedId !== undefined && id !== expectedId) || (expectedThreadId !== undefined && threadId !== expectedThreadId)) return invalidResponse();
  if (input.internalDate !== undefined && (typeof input.internalDate !== "string" || !/^\d{1,16}$/.test(input.internalDate))) return invalidResponse();
  return {
    id, threadId, snippet: shortText(input.snippet, 512),
    ...(input.internalDate !== undefined ? { internalDate: input.internalDate as string } : {}),
    payload: inspectPart(input.payload, budget, 0),
  };
}

export function allParts(part: Part): Part[] {
  return [part, ...part.parts.flatMap(allParts)];
}

const envelopeNames = new Set(["from", "to", "cc", "bcc", "reply-to", "subject", "date", "message-id", "in-reply-to", "references"]);

export async function parseEnvelope(headers: Header[]): Promise<ParsedMail> {
  const source = headers.filter((header) => envelopeNames.has(header.name)).map((header) => `${header.name}: ${header.value}`).join("\r\n");
  return parseMime(`${source}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`);
}

async function parseMime(source: string): Promise<ParsedMail> {
  if (Buffer.byteLength(source) > LIMITS.mimeBytes) return mimeLimit();
  try {
    return await simpleParser(source, {
      skipTextToHtml: true,
      skipImageLinks: true,
      skipTextLinks: true,
      keepCidLinks: true,
      maxHtmlLengthToParse: LIMITS.textBytes,
    });
  } catch {
    throw new ConnectorError("gmail_mime_parse_failed", "The bounded message MIME could not be decoded safely.");
  }
}

function makeMime(part: Part, counter: { next: number }): string | undefined {
  if (isOpaque(part)) {
    // Embedded messages and files stay opaque; only explicit attachment reads return their bytes.
    return undefined;
  }
  if (part.parts.length) {
    const boundary = `connector_mime_${counter.next++}`;
    const children = part.parts.map((child) => makeMime(child, counter)).filter((child) => child !== undefined);
    if (!children.length) return undefined;
    const containerType = part.mimeType === "message/rfc822" ? "multipart/mixed" : part.mimeType;
    return `Content-Type: ${containerType}; boundary="${boundary}"\r\n\r\n${children.map((child) => `--${boundary}\r\n${child}\r\n`).join("")}--${boundary}--\r\n`;
  }
  if (!isBody(part) || part.data === undefined) return undefined;
  const contentType = headerValue(part.headers, "content-type") ?? `${part.mimeType}; charset=utf-8`;
  if (contentType.split(";")[0]?.trim().toLowerCase() !== part.mimeType) return invalidResponse();
  const data = decodeBody(part.data, LIMITS.textBytes).toString("base64");
  return `Content-Type: ${contentType}\r\nContent-Transfer-Encoding: base64\r\n\r\n${data.match(/.{1,76}/g)?.join("\r\n") ?? ""}\r\n`;
}

export function attachmentMetadata(part: Part) {
  return {
    partId: part.partId,
    ...(part.attachmentId ? { attachmentId: part.attachmentId } : {}),
    filename: shortText(part.filename, 512),
    mimeType: part.mimeType,
    size: part.size,
    inline: /^inline(?:;|$)/i.test(headerValue(part.headers, "content-disposition")?.trim() ?? ""),
    downloadable: part.attachmentId !== undefined || part.data !== undefined,
  };
}

export async function renderMessage(message: Message) {
  const parsed = await parseEnvelope(message.payload.headers);
  const body = await parseMime(makeMime(message.payload, { next: 0 }) ?? "Content-Type: text/plain; charset=utf-8\r\n\r\n");
  let bodyText = body.text;
  if (bodyText === undefined && typeof body.html === "string") {
    if (Buffer.byteLength(body.html) > LIMITS.textBytes) return mimeLimit();
    // Mailparser does not produce text for an HTML-only multipart tree; a root HTML part does.
    const encoded = Buffer.from(body.html).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
    const fallback = await parseMime(`Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}`);
    bodyText = fallback.text;
  }
  const text = inertText(bodyText ?? "");
  if (Buffer.byteLength(text) > LIMITS.textBytes) return mimeLimit();
  const parts = allParts(message.payload);
  const attachments = parts.filter((part) => part.attachmentId !== undefined || part.filename || (part.parts.length === 0 && !isBody(part) && part.data !== undefined));
  const unavailableBodyParts = bodyParts(message.payload).filter((part) => part.size > 0 && part.data === undefined);
  return {
    messageId: message.id,
    threadId: message.threadId,
    subject: shortText(parsed.subject, 4_096),
    from: shortText(parsed.from?.text, 4_096),
    to: shortText(Array.isArray(parsed.to) ? parsed.to.map((item) => item.text).join(", ") : parsed.to?.text, 8_192),
    cc: shortText(Array.isArray(parsed.cc) ? parsed.cc.map((item) => item.text).join(", ") : parsed.cc?.text, 8_192),
    ...(parsed.date && Number.isFinite(parsed.date.getTime()) ? { date: parsed.date.toISOString() } : {}),
    ...(message.internalDate ? { internalDate: message.internalDate } : {}),
    snippet: message.snippet,
    body: { contentType: "text/plain", untrusted: true, text, incomplete: unavailableBodyParts.length > 0 },
    ...(unavailableBodyParts.length ? { omittedBodyParts: unavailableBodyParts.map(attachmentMetadata) } : {}),
    attachments: attachments.map(attachmentMetadata),
  };
}
