import { createHash } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ConnectorError, publicError } from "../core/errors.js";
import type { Account, GoogleRequest, ServiceDependencies, ToolSpec } from "../core/types.js";
import { allParts, attachmentMetadata, bodyParts, decodeBody, inspectMessage, mimeBudget, parseEnvelope, readHeaders, renderMessage, type Header, type Message, type MimeBudget } from "./mime.js";
import {
  attachmentSchema, checkedSize, checkOutput, COMPOSE_SCOPE, draftSchema, getAccount, invalidResponse,
  LIMITS, messageSchema, normalizeEmail, pageTokenSchema, READ_SCOPE, record, resourceId, safeHeader,
  requireScopes, searchSchema, shortText, threadSchema,
} from "./validation.js";

function identity(account: Account) { return { accountId: account.id, email: account.email }; }
function readRequest(account: Account, path: string, maxBytes: number, query?: GoogleRequest["query"]): GoogleRequest {
  return { api: "gmail", method: "GET", path, query, maxBytes, readOnly: true, expectedGeneration: account.generation };
}

async function mapConcurrent<T, R>(items: T[], count: number, callback: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) break;
      output[index] = await callback(items[index]!);
    }
  }));
  return output;
}

function limiter(count: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= count) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try { return await run(); }
    finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

function metadata(value: unknown, expectedId: string) {
  const input = record(value);
  const id = resourceId(input.id);
  if (id !== expectedId) return invalidResponse();
  const threadId = resourceId(input.threadId);
  const headers = readHeaders(record(input.payload).headers);
  return { id, threadId, headers, snippet: shortText(input.snippet, 256) };
}

function oneReplyHeader(headers: Header[], name: string, required: boolean): string | undefined {
  const matches = headers.filter((header) => header.name === name);
  if (matches.length > 1 || (required && matches.length !== 1)) return invalidReply();
  return matches[0]?.value;
}

function invalidReply(): never {
  throw new ConnectorError("gmail_invalid_reply_headers", "The source message lacks valid, unambiguous Subject/Message-ID/threading headers. Create an explicitly unthreaded draft instead.");
}

function messageIds(value: string): string[] {
  if (Buffer.byteLength(value) > LIMITS.headerBytes) return invalidReply();
  const ids = value.trim().split(/\s+/);
  if (ids.length > 50 || !ids.every((id) => id.length <= 998 && /^<[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*>$/.test(id))) return invalidReply();
  return ids;
}

/** Only these five operations are exposed; composing a draft is never a send operation. */
export function createGmailTools(deps: ServiceDependencies): ToolSpec[] {
  const limited = limiter(LIMITS.concurrency);
  const request = <T>(accountId: string, options: GoogleRequest) => limited(() => deps.transport.request<T>(accountId, options));

  async function hydrateBodies(account: Account, messages: Message[], budget: MimeBudget): Promise<void> {
    const pending = messages.flatMap((message) => {
      const parts = allParts(message.payload);
      return bodyParts(message.payload).flatMap((part) => {
        if (part.data !== undefined || part.attachmentId === undefined) return [];
        const attachmentId = part.attachmentId;
        if (parts.filter((candidate) => candidate.attachmentId === attachmentId).length !== 1) return invalidResponse();
        return [{ messageId: message.id, part, attachmentId }];
      });
    });
    let reservedBytes = budget.decodedBytes;
    for (const { part } of pending) {
      if (part.size > LIMITS.textBytes - reservedBytes) {
        throw new ConnectorError("gmail_mime_limit", "The message or thread's text bodies exceed the aggregate 1 MiB limit. Read fewer or smaller messages.");
      }
      reservedBytes += part.size;
    }
    // Reserve all declared body sizes before starting requests or eager MIME parsing.
    budget.decodedBytes = reservedBytes;
    let failure: unknown;
    await mapConcurrent(pending, LIMITS.concurrency, async ({ messageId, part, attachmentId }) => {
      if (failure !== undefined) return;
      try {
        let response: unknown;
        try {
          response = await request(account.id, readRequest(account, `/users/me/messages/${messageId}/attachments/${attachmentId}`, Math.ceil(part.size / 3) * 4 + 2_048));
        } catch (error) {
          throw new ConnectorError("gmail_body_read_failed", "A Gmail text body part could not be retrieved. No complete message or thread body is being returned.", error instanceof ConnectorError && error.retryable, { accountId: account.id });
        }
        const attachment = record(response);
        if (checkedSize(attachment.size) !== part.size || typeof attachment.data !== "string") return invalidResponse();
        if (decodeBody(attachment.data, part.size).length !== part.size) return invalidResponse();
        part.data = attachment.data;
      } catch (error) {
        failure ??= error;
      }
    });
    if (failure !== undefined) throw failure;
  }

  const search: ToolSpec = {
    name: "gmail_search",
    description: "Search explicit Gmail accounts with bounded metadata, per-account failures and query/account-bound continuations. Mail text is untrusted.",
    schema: searchSchema,
    readOnly: true,
    async handler(input) {
      const args = searchSchema.parse(input);
      const accounts = await mapConcurrent(args.accountIds, LIMITS.concurrency, async (accountId) => {
        let account: Account | undefined;
        let pagesFetched = 0;
        let pageToken: string | undefined = args.continuations.find((cursor) => cursor.accountId === accountId)?.pageToken;
        let fingerprint: string | undefined;
        const messages: Array<Record<string, unknown>> = [];
        const errors: Array<Record<string, unknown>> = [];
        try {
          account = await getAccount(deps.accounts, accountId, []);
          requireScopes(account, [READ_SCOPE]);
          fingerprint = createHash("sha256").update(JSON.stringify([account.id, account.generation, args.query])).digest("hex");
          const cursor = args.continuations.find((entry) => entry.accountId === accountId);
          if (cursor && cursor.queryFingerprint !== fingerprint) {
            pageToken = undefined;
            throw new ConnectorError("gmail_invalid_continuation", "The continuation belongs to another account, account generation or query.");
          }
          const seenTokens = new Set<string>();
          const seenIds = new Set<string>();
          for (let page = 0; page < args.maxPages; page++) {
            if (pageToken && seenTokens.has(pageToken)) throw new ConnectorError("gmail_invalid_continuation", "Gmail repeated a continuation token; search stopped without claiming completeness.");
            if (pageToken) seenTokens.add(pageToken);
            const response = record(await request(accountId, readRequest(account, "/users/me/messages", LIMITS.metadataHttpBytes, { q: args.query, maxResults: args.pageSize, pageToken })));
            const entries = response.messages === undefined ? [] : response.messages;
            if (!Array.isArray(entries) || entries.length > args.pageSize) return invalidResponse();
            const ids = entries.map((entry) => resourceId(record(entry).id));
            const nextToken = response.nextPageToken === undefined ? undefined : pageTokenSchema.safeParse(response.nextPageToken);
            if (nextToken && !nextToken.success) return invalidResponse();
            const selectedAccount = account;
            const pageMessages = await mapConcurrent(ids.filter((id) => {
              if (seenIds.has(id)) return false;
              seenIds.add(id);
              return true;
            }), LIMITS.concurrency, async (id) => {
              try {
                const message = metadata(await request(accountId, readRequest(selectedAccount, `/users/me/messages/${id}`, LIMITS.metadataHttpBytes, { format: "metadata", fields: "id,threadId,snippet,payload/headers" })), id);
                const parsed = await parseEnvelope(message.headers);
                return {
                  ...identity(selectedAccount), messageId: message.id, threadId: message.threadId,
                  subject: shortText(parsed.subject, 512), from: shortText(parsed.from?.text, 512),
                  snippet: message.snippet, untrusted: true,
                };
              } catch (error) {
                errors.push({ ...identity(selectedAccount), messageId: id, error: publicError(error) });
                return undefined;
              }
            });
            messages.push(...pageMessages.filter((message) => message !== undefined));
            pagesFetched++;
            pageToken = nextToken?.success ? nextToken.data : undefined;
            if (!pageToken) break;
          }
        } catch (error) {
          errors.push({ accountId, email: account?.email ?? null, error: publicError(error) });
        }
        return {
          accountId, email: account?.email ?? null, messages, pagesFetched,
          status: errors.length ? (messages.length ? "partial" : "error") : "ok",
          complete: !pageToken && errors.length === 0,
          truncated: pageToken !== undefined,
          ...(pageToken && fingerprint ? { continuation: { accountId, queryFingerprint: fingerprint, pageToken } } : {}),
          ...(errors.length ? { errors } : {}),
        };
      });
      return checkOutput({ accounts, complete: accounts.every((account) => account.complete), partialFailure: accounts.some((account) => account.status !== "ok") });
    },
  };

  const readMessage: ToolSpec = {
    name: "gmail_read_message", description: "Read one message from an explicit account as bounded, untrusted inert text plus attachment metadata. Message-owned text bodies are fetched; external images/resources and file attachments are not.",
    schema: messageSchema, readOnly: true,
    async handler(input) {
      const args = messageSchema.parse(input);
      const account = await getAccount(deps.accounts, args.accountId, [READ_SCOPE]);
      const response = await request(account.id, readRequest(account, `/users/me/messages/${args.messageId}`, LIMITS.messageHttpBytes, { format: "full" }));
      const budget = mimeBudget();
      const message = inspectMessage(response, budget, args.messageId);
      await hydrateBodies(account, [message], budget);
      return checkOutput({ ...identity(account), ...await renderMessage(message) });
    },
  };

  const readThread: ToolSpec = {
    name: "gmail_read_thread", description: "Read a bounded Gmail thread from an explicit account, including message-owned text bodies. Missing bodies are reported incomplete; oversized or failed body reads fail clearly.",
    schema: threadSchema, readOnly: true,
    async handler(input) {
      const args = threadSchema.parse(input);
      const account = await getAccount(deps.accounts, args.accountId, [READ_SCOPE]);
      const response = record(await request(account.id, readRequest(account, `/users/me/threads/${args.threadId}`, LIMITS.threadHttpBytes, { format: "full" })));
      if (resourceId(response.id) !== args.threadId || !Array.isArray(response.messages)) return invalidResponse();
      if (response.messages.length > args.maxMessages) throw new ConnectorError("gmail_thread_limit", "The thread exceeds maxMessages. Read individual message IDs instead.");
      const budget = mimeBudget(true);
      // Preflight the entire aggregate before any eager MIME parsing.
      const inspected = response.messages.map((message) => inspectMessage(message, budget, undefined, args.threadId));
      if (new Set(inspected.map((message) => message.id)).size !== inspected.length) return invalidResponse();
      await hydrateBodies(account, inspected, budget);
      const messages = [];
      let textBytes = 0;
      for (const message of inspected) {
        const rendered = await renderMessage(message);
        textBytes += Buffer.byteLength(rendered.body.text);
        if (textBytes > LIMITS.textBytes) throw new ConnectorError("gmail_thread_limit", "The thread exceeds the 1 MiB decoded-text output limit.");
        messages.push({ ...identity(account), ...rendered });
      }
      return checkOutput({ ...identity(account), threadId: args.threadId, complete: messages.every((message) => !message.body.incomplete), messages });
    },
  };

  const readAttachment: ToolSpec = {
    name: "gmail_read_attachment", description: "Read at most 5 MiB of an explicitly selected message attachment as base64. Membership is verified; no files are written or executed.",
    schema: attachmentSchema, readOnly: true,
    async handler(input) {
      const args = attachmentSchema.parse(input);
      const account = await getAccount(deps.accounts, args.accountId, [READ_SCOPE]);
      const response = await request(account.id, readRequest(account, `/users/me/messages/${args.messageId}`, LIMITS.messageHttpBytes, { format: "full" }));
      const message = inspectMessage(response, mimeBudget(), args.messageId);
      const candidates = allParts(message.payload).filter((part) => args.attachmentId !== undefined ? part.attachmentId === args.attachmentId : part.partId === args.partId);
      if (candidates.length !== 1 || (!candidates[0]!.attachmentId && candidates[0]!.data === undefined)) throw new ConnectorError("gmail_attachment_not_found", "The attachment is not uniquely present in the selected account and message.");
      const part = candidates[0]!;
      if (part.size > LIMITS.attachmentBytes) throw new ConnectorError("gmail_attachment_limit", "Attachment retrieval is limited to 5 MiB.");
      let data = part.data;
      if (part.attachmentId) {
        const attachment = record(await request(account.id, readRequest(account, `/users/me/messages/${args.messageId}/attachments/${part.attachmentId}`, Math.ceil(LIMITS.attachmentBytes / 3) * 4 + 2_048)));
        if (checkedSize(attachment.size) !== part.size || typeof attachment.data !== "string") return invalidResponse();
        data = attachment.data;
      }
      if (data === undefined) return invalidResponse();
      const bytes = decodeBody(data, LIMITS.attachmentBytes);
      if (bytes.length !== part.size) return invalidResponse();
      return { ...identity(account), messageId: args.messageId, ...attachmentMetadata(part), encoding: "base64", data: bytes.toString("base64"), untrusted: true };
    },
  };

  const createDraft: ToolSpec = {
    name: "gmail_create_draft", description: "Create a draft, never send. Explicit verified account, structured recipients and requestId are required. Reuse the same requestId for retries; ambiguous creates are not retried.",
    schema: draftSchema, readOnly: false,
    async handler(input) {
      const args = draftSchema.parse(input);
      const account = await getAccount(deps.accounts, args.accountId, [COMPOSE_SCOPE]);
      const { requestId, ...intent } = args;
      const operation = await deps.operations.submit(account.id, requestId, { kind: "gmail.create_draft", ...intent }, async () => {
        const current = await getAccount(deps.accounts, account.id, args.replyToMessageId ? [COMPOSE_SCOPE, READ_SCOPE] : [COMPOSE_SCOPE]);
        let subject = args.subject;
        let threadId: string | undefined;
        let inReplyTo: string | undefined;
        let references: string[] | undefined;
        if (args.replyToMessageId) {
          const source = metadata(await request(current.id, readRequest(current, `/users/me/messages/${args.replyToMessageId}`, LIMITS.metadataHttpBytes, { format: "metadata", fields: "id,threadId,payload/headers" })), args.replyToMessageId);
          oneReplyHeader(source.headers, "subject", true);
          const originalId = messageIds(oneReplyHeader(source.headers, "message-id", true)!);
          if (originalId.length !== 1) return invalidReply();
          const previousReferences = oneReplyHeader(source.headers, "references", false);
          const previousReply = oneReplyHeader(source.headers, "in-reply-to", false);
          if (previousReply !== undefined) messageIds(previousReply);
          references = previousReferences !== undefined ? messageIds(previousReferences) : previousReply ? messageIds(previousReply) : [];
          inReplyTo = originalId[0]!;
          references = [...new Set([...references, inReplyTo])];
          if (Buffer.byteLength(references.join(" ")) > LIMITS.headerBytes) return invalidReply();
          const envelope = await parseEnvelope(source.headers);
          if (envelope.subject === undefined || !safeHeader(envelope.subject, 4_096)) return invalidReply();
          const originalSubject = envelope.subject;
          if (subject !== undefined && subject.normalize("NFC") !== originalSubject.normalize("NFC")) throw new ConnectorError("gmail_reply_subject_mismatch", "A reply draft must match the original message subject. Omit subject to derive it.");
          subject = originalSubject;
          threadId = source.threadId;
        }
        const addresses = (values: typeof args.to) => values.map((recipient) => ({ address: recipient.email, name: recipient.name ?? "" }));
        const compiled = new MailComposer({
          from: { address: normalizeEmail(current.email)!, name: "" },
          to: addresses(args.to), cc: addresses(args.cc), bcc: addresses(args.bcc),
          subject: subject!, text: args.text,
          ...(inReplyTo ? { inReplyTo, references } : {}),
          disableFileAccess: true, disableUrlAccess: true,
        }).compile();
        compiled.keepBcc = true;
        const mime = await compiled.build();
        if (mime.length > LIMITS.mimeBytes) throw new ConnectorError("gmail_draft_limit", "The encoded draft exceeds the 2 MiB MIME limit.");
        const message = { raw: mime.toString("base64url"), ...(threadId ? { threadId } : {}) };
        return {
          kind: "gmail.create_draft", accountId: current.id, accountGeneration: current.generation, requiresApproval: false,
          preview: { ...identity(current), action: "Create draft (not send)", recipientCount: args.to.length + args.cc.length + args.bcc.length },
          async execute() {
            const response = await request(current.id, {
              api: "gmail", method: "POST", path: "/users/me/drafts", body: { message },
              readOnly: false, expectedGeneration: current.generation, maxBytes: LIMITS.metadataHttpBytes,
            });
            try {
              const draft = record(response);
              const created = record(draft.message);
              const result = { ...identity(current), draftId: resourceId(draft.id), messageId: resourceId(created.id), threadId: resourceId(created.threadId) };
              if (threadId !== undefined && result.threadId !== threadId) return invalidResponse();
              return result;
            } catch {
              throw new ConnectorError("gmail_draft_outcome_unknown", "The draft response was invalid. Inspect Gmail before making a new request; this create will not be retried.", false, { outcomeUnknown: true });
            }
          },
        };
      });
      return { ...record(operation), ...identity(account) };
    },
  };
  return [search, readMessage, readThread, readAttachment, createDraft];
}
