import test from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { ConnectorError } from "../core/errors.js";
import type { Account, Accounts, GoogleRequest, GoogleTransport, MutationPlan, OperationSubmitter } from "../core/types.js";
import { createGmailTools } from "../gmail/index.js";
import { COMPOSE_SCOPE, LIMITS, READ_SCOPE } from "../gmail/validation.js";

const first: Account = {
  id: "account-one", email: "one@example.test", subject: "subject-one", clientId: "client",
  generation: "generation-one", scopes: [READ_SCOPE, COMPOSE_SCOPE],
};
const second: Account = { ...first, id: "account-two", email: "two@example.test", subject: "subject-two", generation: "generation-two" };

class FakeAccounts implements Accounts {
  readonly records = new Map([first, second].map((account) => [account.id, structuredClone(account)]));
  async list() { return [...this.records.values()]; }
  async get(id: string) {
    const account = this.records.get(id);
    if (!account) throw new ConnectorError("account_not_found", "No such account.");
    return structuredClone(account);
  }
}

interface Call { accountId: string; request: GoogleRequest }
class FakeTransport implements GoogleTransport {
  calls: Call[] = [];
  respond: (call: Call) => Promise<unknown> = async () => { throw new Error("Unexpected fake API call."); };
  active = 0;
  maxActive = 0;
  async request<T>(accountId: string, request: GoogleRequest): Promise<T> {
    this.calls.push({ accountId, request });
    assert.equal(request.api, "gmail");
    assert.ok(request.maxBytes && request.maxBytes > 0);
    assert.ok(request.expectedGeneration);
    assert.match(request.path, /^\/users\/me\//);
    this.maxActive = Math.max(this.maxActive, ++this.active);
    try { return await this.respond({ accountId, request }) as T; }
    finally { this.active--; }
  }
}

class FakeOperations implements OperationSubmitter {
  reserved = false;
  prepares = 0;
  intents: unknown[] = [];
  plans: MutationPlan[] = [];
  receipts = new Map<string, { intent: string; result: unknown }>();
  async submit(accountId: string, requestId: string, intent: unknown, prepare: () => Promise<MutationPlan>) {
    const key = `${accountId}/${requestId}`;
    const existing = this.receipts.get(key);
    if (existing) {
      if (existing.intent !== JSON.stringify(intent)) throw new ConnectorError("request_id_conflict", "Different payload.");
      return existing.result;
    }
    this.reserved = true;
    this.intents.push(intent);
    this.prepares++;
    const plan = await prepare();
    assert.equal(plan.accountId, accountId);
    assert.equal(plan.requiresApproval, false);
    this.plans.push(plan);
    let result: unknown;
    try { result = { accountId, requestId, status: "succeeded", result: await plan.execute() }; }
    catch (error) {
      if (error instanceof ConnectorError && error.details?.outcomeUnknown === true) result = { accountId, requestId, status: "outcome_unknown" };
      else throw error;
    }
    this.receipts.set(key, { intent: JSON.stringify(intent), result });
    return result;
  }
}

function fixture() {
  const accounts = new FakeAccounts();
  const transport = new FakeTransport();
  const operations = new FakeOperations();
  const tools = createGmailTools({ accounts, transport, operations });
  const call = async (name: string, input: Record<string, unknown>) => {
    const tool = tools.find((item) => item.name === name)!;
    return await tool.handler(input) as Record<string, any>;
  };
  return { accounts, transport, operations, tools, call };
}

function part(text = "Hello world", mimeType = "text/plain", partId = "") {
  const bytes = Buffer.from(text);
  return {
    partId, mimeType, filename: "", headers: [{ name: "Content-Type", value: `${mimeType}; charset=utf-8` }],
    body: { size: bytes.length, data: bytes.toString("base64url") },
  };
}
function fullMessage(id = "message-one", threadId = "thread-one", text = "Hello world") {
  const payload = part(text);
  payload.headers.push(
    { name: "From", value: "Sender <sender@example.test>" },
    { name: "To", value: first.email },
    { name: "Subject", value: "A subject" },
    { name: "Message-ID", value: "<rfc-message@example.test>" },
  );
  return { id, threadId, payload };
}
function draftInput(extra: Record<string, unknown> = {}) {
  return { accountId: first.id, requestId: "request-one", to: [{ email: "recipient@example.test" }], subject: "A subject", text: "Draft body", ...extra };
}
function createdDraft(threadId = "thread-created") {
  return { id: "draft-one", message: { id: "created-message", threadId } };
}
function addAttachment(message = fullMessage(), size = 4, attachmentId = "attachment-one") {
  return {
    ...message,
    payload: {
      partId: "", mimeType: "multipart/mixed", filename: "", headers: message.payload.headers, body: { size: 0 },
      parts: [
        { ...message.payload, partId: "0" },
        { partId: "1", mimeType: "application/octet-stream", filename: "sample.bin", headers: [], body: { size, attachmentId } },
      ],
    },
  };
}

function externalPart(bytes: Buffer, attachmentId = "external-body", mimeType = "text/plain", partId = "") {
  return { ...part("", mimeType, partId), body: { size: bytes.length, attachmentId } };
}

test("Gmail exposes exactly five tools, strict schemas and explicit account/request selection", async () => {
  const f = fixture();
  assert.deepEqual(f.tools.map((tool) => tool.name), ["gmail_search", "gmail_read_message", "gmail_read_thread", "gmail_read_attachment", "gmail_create_draft"]);
  assert.equal(f.tools.filter((tool) => !tool.readOnly).length, 1);
  for (const tool of f.tools) assert.equal(tool.schema.safeParse({}).success, false);
  for (const accountIds of [[], ["*"], [first.id, first.id]]) await assert.rejects(f.call("gmail_search", { accountIds, query: "" }));
  await assert.rejects(f.call("gmail_search", { accountIds: [first.id], query: "", includeSpamTrash: true }));
  await assert.rejects(f.call("gmail_read_message", { accountId: first.id, messageId: "../anything" }));
  await assert.rejects(f.call("gmail_create_draft", draftInput({ requestId: undefined })));
  await assert.rejects(f.call("gmail_create_draft", draftInput({ from: "spoof@example.test" })));
  await assert.rejects(f.call("gmail_create_draft", draftInput({ headers: { Bcc: "secret@example.test" } })));
  await assert.rejects(f.call("gmail_create_draft", draftInput({ to: [{ email: "ok@example.test", raw: true }] })));
  assert.equal(f.transport.calls.length, 0);
});

test("search isolates account endpoints, bounds concurrency, returns partial failures without secrets", async () => {
  const f = fixture();
  f.transport.respond = async ({ accountId, request }) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (accountId === second.id) throw new Error("access_token=DO-NOT-LEAK", { cause: { refresh_token: "NESTED-SECRET" } });
    if (request.path === "/users/me/messages") return { messages: Array.from({ length: 8 }, (_, index) => ({ id: `message-${index}` })) };
    return fullMessage(request.path.split("/").at(-1));
  };
  const result = await f.call("gmail_search", { accountIds: [first.id, second.id], query: "in:inbox", pageSize: 8 });
  assert.equal(result.complete, false);
  assert.equal(result.partialFailure, true);
  assert.equal(result.accounts[0].email, first.email);
  assert.equal(result.accounts[0].messages.length, 8);
  assert.equal(result.accounts[1].status, "error");
  assert.equal(result.accounts[1].email, second.email);
  assert.equal(result.accounts[1].errors[0].accountId, second.id);
  assert.doesNotMatch(JSON.stringify(result), /DO-NOT-LEAK|NESTED-SECRET/);
  assert.ok(f.transport.maxActive > 1);
  assert.ok(f.transport.maxActive <= LIMITS.concurrency);
  assert.ok(f.transport.calls.every(({ request }) => request.method === "GET" && request.readOnly === true));
});

test("search pagination binds account, query and generation and preserves partial metadata failures", async () => {
  const f = fixture();
  f.transport.respond = async ({ request }) => {
    if (request.path === "/users/me/messages") return request.query?.pageToken ? { messages: [{ id: "message-two" }] } : { messages: [{ id: "message-one" }], nextPageToken: "next-page" };
    if (request.path.endsWith("message-two")) throw new ConnectorError("forbidden", "Message is no longer available.");
    return fullMessage();
  };
  const firstPage = await f.call("gmail_search", { accountIds: [first.id], query: "from:person", pageSize: 1 });
  const cursor = firstPage.accounts[0].continuation;
  assert.equal(firstPage.accounts[0].truncated, true);
  assert.equal(firstPage.complete, false);
  assert.equal(cursor.accountId, first.id);
  const inputCursor = { accountId: cursor.accountId, queryFingerprint: cursor.queryFingerprint, pageToken: cursor.pageToken };
  const before = f.transport.calls.length;
  const wrongQuery = await f.call("gmail_search", { accountIds: [first.id], query: "different", continuations: [inputCursor] });
  assert.equal(wrongQuery.accounts[0].status, "error");
  assert.equal(wrongQuery.accounts[0].continuation, undefined);
  assert.equal(f.transport.calls.length, before);
  const wrongAccount = await f.call("gmail_search", { accountIds: [second.id], query: "from:person", continuations: [{ ...inputCursor, accountId: second.id }] });
  assert.equal(wrongAccount.accounts[0].status, "error");
  const result = await f.call("gmail_search", { accountIds: [first.id], query: "from:person", continuations: [inputCursor] });
  assert.equal(result.accounts[0].status, "error");
  assert.equal(result.accounts[0].complete, false);
  assert.equal(result.accounts[0].errors[0].messageId, "message-two");
  f.accounts.records.get(first.id)!.generation = "new-generation";
  const changed = await f.call("gmail_search", { accountIds: [first.id], query: "from:person", continuations: [inputCursor] });
  assert.equal(changed.accounts[0].errors[0].error.code, "gmail_invalid_continuation");
});

test("search honors maximum pages and reports a list failure after an earlier successful page", async () => {
  const f = fixture();
  f.transport.respond = async ({ request }) => {
    if (request.path !== "/users/me/messages") return fullMessage();
    if (request.query?.pageToken) throw new Error("Provider body SECRET");
    return { messages: [{ id: "message-one" }], nextPageToken: "next-page" };
  };
  const result = await f.call("gmail_search", { accountIds: [first.id], query: "", maxPages: 3, pageSize: 1 });
  assert.equal(result.accounts[0].status, "partial");
  assert.equal(result.accounts[0].pagesFetched, 1);
  assert.equal(result.accounts[0].messages.length, 1);
  assert.equal(result.accounts[0].continuation.pageToken, "next-page");
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.equal(f.transport.calls.filter(({ request }) => request.path === "/users/me/messages").length, 2);
});

test("search cursors round-trip unchanged and repeated tokens or malformed lists do not claim completeness", async () => {
  const f = fixture();
  f.transport.respond = async ({ request }) => request.path === "/users/me/messages" ? { messages: [{ id: "message-one" }], nextPageToken: "repeated" } : fullMessage();
  const firstPage = await f.call("gmail_search", { accountIds: [first.id], query: "", pageSize: 1 });
  const result = await f.call("gmail_search", { accountIds: [first.id], query: "", pageSize: 1, maxPages: 3, continuations: [firstPage.accounts[0].continuation] });
  assert.equal(result.accounts[0].status, "partial");
  assert.equal(result.accounts[0].complete, false);
  assert.equal(result.accounts[0].pagesFetched, 1);
  assert.equal(result.accounts[0].errors[0].error.code, "gmail_invalid_continuation");
  f.transport.respond = async () => ({ messages: null });
  const invalid = await f.call("gmail_search", { accountIds: [first.id], query: "" });
  assert.equal(invalid.accounts[0].status, "error");
  assert.equal(invalid.complete, false);
});

test("message reads decode nested alternative MIME, legacy charset, encoded headers and Unicode", async () => {
  const f = fixture();
  const message = fullMessage();
  const charsetBytes = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
  message.payload.headers = [
    { name: "Subject", value: "=?UTF-8?B?5L2g5aW9?=" },
    { name: "From", value: "=?UTF-8?B?Sm9zw6k=?= <sender@example.test>" },
  ];
  f.transport.respond = async () => ({
    ...message,
    payload: {
      ...message.payload, mimeType: "multipart/mixed", body: { size: 0 },
      parts: [{
        partId: "0", mimeType: "multipart/alternative", headers: [], body: { size: 0 },
        parts: [
          { ...part("", "text/plain", "0.0"), headers: [{ name: "Content-Type", value: "text/plain; charset=iso-8859-1" }], body: { size: charsetBytes.length, data: charsetBytes.toString("base64url") } },
          part("<html><body>Do not choose this<img src=\"https://example.invalid/tracker\"></body></html>", "text/html", "0.1"),
        ],
      }],
    },
  });
  const result = await f.call("gmail_read_message", { accountId: first.id, messageId: message.id });
  assert.equal(result.accountId, first.id);
  assert.equal(result.email, first.email);
  assert.equal(result.subject, "你好");
  assert.match(result.from, /José/);
  assert.equal(result.body.text.trim(), "café");
  assert.equal(result.body.contentType, "text/plain");
  assert.equal(result.body.untrusted, true);
  assert.equal(result.body.incomplete, false);
  assert.equal(result.body.html, undefined);
  assert.equal(f.transport.calls.length, 1);
  assert.equal(f.transport.calls[0]!.request.query?.format, "full");
});

test("HTML-only bodies become inert text without images, script or automatic attachment downloads", async () => {
  const f = fixture();
  const message = addAttachment(fullMessage());
  message.payload.parts[0] = part("<p>Hello &amp; <b>goodbye</b></p><script>alert('bad')</script><img src=\"https://example.invalid/pixel\">", "text/html", "0") as typeof message.payload.parts[0];
  f.transport.respond = async () => message;
  const result = await f.call("gmail_read_message", { accountId: first.id, messageId: message.id });
  assert.match(result.body.text, /Hello & goodbye/);
  assert.doesNotMatch(result.body.text, /<script|<img|alert\('bad'\)/);
  assert.equal(result.attachments[0].attachmentId, "attachment-one");
  assert.equal(f.transport.calls.length, 1);
});

test("message reads fetch a verified external plain-text body with charset decoding and bounded HTTP", async () => {
  const f = fixture();
  const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
  f.transport.respond = async ({ request }) => {
    if (request.path === "/users/me/messages/message-one/attachments/external-body") return { size: bytes.length, data: bytes.toString("base64url") };
    assert.equal(request.path, "/users/me/messages/message-one");
    return {
      ...fullMessage(),
      payload: {
        ...externalPart(bytes),
        headers: [{ name: "Content-Type", value: "text/plain; charset=iso-8859-1" }],
        body: { size: bytes.length, attachmentId: "external-body", data: "" },
      },
    };
  };
  const result = await f.call("gmail_read_message", { accountId: second.id, messageId: "message-one" });
  assert.equal(result.email, second.email);
  assert.equal(result.body.text, "café");
  assert.equal(result.body.incomplete, false);
  assert.equal(result.omittedBodyParts, undefined);
  assert.equal(f.transport.calls.length, 2);
  assert.ok(f.transport.calls.every((call) => call.accountId === second.id && call.request.expectedGeneration === second.generation && call.request.readOnly === true));
  assert.equal(f.transport.calls[1]!.request.maxBytes, Math.ceil(bytes.length / 3) * 4 + 2_048);
});

test("external HTML bodies become inert text while text files, images and RFC822 attachments stay opaque", async () => {
  const f = fixture();
  const bytes = Buffer.from("<p>Hello &amp; <b>café</b></p><img src=\"https://example.invalid/pixel\"><script>unsafe()</script>");
  f.transport.respond = async ({ request }) => {
    if (request.path === "/users/me/messages/message-one/attachments/html-body") return { size: bytes.length, data: bytes.toString("base64url") };
    assert.equal(request.path, "/users/me/messages/message-one");
    return {
      ...fullMessage(),
      payload: {
        partId: "", mimeType: "multipart/mixed", headers: [], body: { size: 0 },
        parts: [
          { partId: "0", mimeType: "multipart/related", headers: [], body: { size: 0 }, parts: [
            externalPart(bytes, "html-body", "text/html", "0.0"),
            { ...externalPart(Buffer.from("image"), "image-file", "image/png", "0.1"), filename: "image.png" },
          ] },
          { ...externalPart(Buffer.from("text file"), "text-file", "text/plain", "1"), filename: "notes.txt" },
          { ...externalPart(Buffer.from("named by disposition"), "disposition-file", "text/plain", "2"), headers: [{ name: "Content-Disposition", value: "attachment; filename=notes.txt" }] },
          externalPart(Buffer.from("raw email"), "raw-email", "message/rfc822", "3"),
          { partId: "4", mimeType: "message/rfc822", filename: "source.eml", headers: [], body: { size: 0 }, parts: [
            externalPart(Buffer.from("embedded email body"), "embedded-file-body", "text/plain", "4.0"),
          ] },
        ],
      },
    };
  };
  const result = await f.call("gmail_read_message", { accountId: first.id, messageId: "message-one" });
  assert.match(result.body.text, /Hello & café/);
  assert.doesNotMatch(result.body.text, /<img|<script|unsafe\(\)/);
  assert.equal(result.body.incomplete, false);
  assert.equal(f.transport.calls.length, 2);
  assert.ok(result.attachments.some((attachment: any) => attachment.attachmentId === "text-file"));
  assert.ok(result.attachments.some((attachment: any) => attachment.attachmentId === "raw-email"));
});

test("threads hydrate external bodies with bounded concurrency and message-bound attachment endpoints", async () => {
  const f = fixture();
  const texts = Array.from({ length: 8 }, (_, index) => Buffer.from(`External body ${index} café`));
  f.transport.respond = async ({ request }) => {
    if (request.path === "/users/me/threads/thread-one") return {
      id: "thread-one",
      messages: texts.map((bytes, index) => ({
        ...fullMessage(`message-${index}`),
        payload: {
          partId: "", mimeType: "multipart/mixed", headers: [], body: { size: 0 },
          parts: [part(`Inline body ${index}`, "text/plain", "0"), externalPart(bytes, "same-attachment-id", "text/plain", "1")],
        },
      })),
    };
    const match = /^\/users\/me\/messages\/message-(\d+)\/attachments\/same-attachment-id$/.exec(request.path);
    assert.ok(match);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const bytes = texts[Number(match[1])]!;
    return { size: bytes.length, data: bytes.toString("base64url") };
  };
  const result = await f.call("gmail_read_thread", { accountId: second.id, threadId: "thread-one" });
  assert.equal(result.complete, true);
  result.messages.forEach((message: any, index: number) => {
    assert.equal(message.accountId, second.id);
    assert.equal(message.body.incomplete, false);
    assert.match(message.body.text, new RegExp(`Inline body ${index}`));
    assert.match(message.body.text, new RegExp(`External body ${index} café`));
  });
  assert.equal(f.transport.calls.length, 9);
  assert.ok(f.transport.maxActive > 1 && f.transport.maxActive <= LIMITS.concurrency);
  assert.ok(f.transport.calls.every((call) => call.accountId === second.id && call.request.expectedGeneration === second.generation));
});

test("external bodies reserve the aggregate text budget before any attachment requests", async () => {
  for (const mode of ["message", "external-thread", "mixed-thread"]) {
    const f = fixture();
    f.transport.respond = async () => {
      if (mode === "message") return { ...fullMessage(), payload: externalPart(Buffer.alloc(LIMITS.textBytes + 1)) };
      return {
        id: "thread-one",
        messages: [
          mode === "mixed-thread" ? fullMessage("message-one", "thread-one", "x".repeat(600_000)) : { ...fullMessage(), payload: externalPart(Buffer.alloc(600_000)) },
          { ...fullMessage("message-two"), payload: externalPart(Buffer.alloc(600_000)) },
        ],
      };
    };
    await assert.rejects(
      f.call(mode === "message" ? "gmail_read_message" : "gmail_read_thread", mode === "message" ? { accountId: first.id, messageId: "message-one" } : { accountId: first.id, threadId: "thread-one" }),
      { code: "gmail_mime_limit" },
    );
    assert.equal(f.transport.calls.length, 1);
  }
});

test("external body responses enforce declared size and canonical bounded base64", async () => {
  for (const response of [
    { size: 4 },
    { size: 5, data: Buffer.from("data").toString("base64url") },
    { size: 4, data: "!!!!" },
    { size: 4, data: "ZGF0YR" },
    { size: 4, data: Buffer.from("too much data").toString("base64url") },
  ]) {
    const f = fixture();
    f.transport.respond = async ({ request }) => request.path.includes("/attachments/") ? response : { ...fullMessage(), payload: externalPart(Buffer.from("data")) };
    await assert.rejects(f.call("gmail_read_message", { accountId: first.id, messageId: "message-one" }));
    assert.equal(f.transport.calls.length, 2);
  }
});

test("failed external-body retrieval never returns a complete thread or exposes provider secrets", async () => {
  const f = fixture();
  f.transport.respond = async ({ request }) => {
    if (request.path === "/users/me/threads/thread-one") return {
      id: "thread-one",
      messages: Array.from({ length: 8 }, (_, index) => ({ ...fullMessage(`message-${index}`), payload: externalPart(Buffer.from("body")) })),
    };
    await new Promise((resolve) => setTimeout(resolve, 2));
    throw new Error("SECRET provider body", { cause: { access_token: "NESTED SECRET" } });
  };
  await assert.rejects(f.call("gmail_read_thread", { accountId: first.id, threadId: "thread-one" }), (error: unknown) => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "gmail_body_read_failed");
    assert.doesNotMatch(error.message + JSON.stringify(error.details), /SECRET/);
    return true;
  });
  assert.ok(f.transport.calls.length <= 1 + LIMITS.concurrency);
  assert.equal(f.transport.active, 0);
});

test("unretrievable body bytes without an attachment identifier make thread completeness false", async () => {
  const f = fixture();
  f.transport.respond = async () => ({
    id: "thread-one",
    messages: [{ ...fullMessage(), payload: { ...part(), body: { size: 12 } } }],
  });
  const result = await f.call("gmail_read_thread", { accountId: first.id, threadId: "thread-one" });
  assert.equal(result.complete, false);
  assert.equal(result.messages[0].body.incomplete, true);
  assert.equal(f.transport.calls.length, 1);
});

test("inline nested message trees are decoded while raw RFC822 attachments remain opaque", async () => {
  const f = fixture();
  const embedded = Buffer.from("Content-Type: text/html\r\n\r\n<script>unsafe()</script>");
  f.transport.respond = async () => ({
    ...fullMessage(),
    payload: {
      partId: "", mimeType: "multipart/mixed", headers: [], body: { size: 0 },
      parts: [
        { partId: "0", mimeType: "message/rfc822", headers: [], body: { size: 0 }, parts: [part("Nested café", "text/plain", "0.0")] },
        { partId: "1", mimeType: "message/rfc822", filename: "original.eml", headers: [], body: { size: embedded.length, data: embedded.toString("base64url") } },
      ],
    },
  });
  const result = await f.call("gmail_read_message", { accountId: first.id, messageId: "message-one" });
  assert.match(result.body.text, /Nested café/);
  assert.doesNotMatch(result.body.text, /unsafe/);
  assert.equal(result.attachments[0].filename, "original.eml");
  assert.equal(result.attachments[0].partId, "1");
});

test("message and thread limits reject depth, part count, malformed base64 and aggregate data before parsing", async () => {
  const f = fixture();
  let node: Record<string, unknown> = part();
  for (let depth = 0; depth < LIMITS.mimeDepth + 1; depth++) node = { mimeType: "multipart/mixed", body: { size: 0 }, parts: [node] };
  f.transport.respond = async () => ({ ...fullMessage(), payload: node });
  await assert.rejects(f.call("gmail_read_message", { accountId: first.id, messageId: "message-one" }), { code: "gmail_mime_limit" });
  f.transport.respond = async () => ({ ...fullMessage(), payload: { mimeType: "multipart/mixed", body: { size: 0 }, parts: Array.from({ length: 201 }, () => part()) } });
  await assert.rejects(f.call("gmail_read_message", { accountId: first.id, messageId: "message-one" }), { code: "gmail_mime_limit" });
  f.transport.respond = async () => ({ ...fullMessage(), payload: { ...part(), body: { size: 3, data: "%%%" } } });
  await assert.rejects(f.call("gmail_read_message", { accountId: first.id, messageId: "message-one" }), { code: "gmail_invalid_response" });
  const big = "a".repeat(600_000);
  f.transport.respond = async () => ({ id: "thread-one", messages: [fullMessage("message-one", "thread-one", big), fullMessage("message-two", "thread-one", big)] });
  await assert.rejects(f.call("gmail_read_thread", { accountId: first.id, threadId: "thread-one" }), { code: "gmail_mime_limit" });
  f.transport.respond = async () => ({ id: "thread-one", messages: [fullMessage(), fullMessage("message-two")] });
  await assert.rejects(f.call("gmail_read_thread", { accountId: first.id, threadId: "thread-one", maxMessages: 1 }), { code: "gmail_thread_limit" });
});

test("header, individual decoded text and charset-expanded output limits fail safely", async () => {
  const f = fixture();
  f.transport.respond = async () => ({
    ...fullMessage(), payload: { ...part(), headers: [{ name: "Subject", value: "s".repeat(LIMITS.headerBytes + 1) }] },
  });
  await assert.rejects(f.call("gmail_read_message", { accountId: first.id, messageId: "message-one" }), { code: "gmail_mime_limit" });
  f.transport.respond = async () => fullMessage("message-one", "thread-one", "x".repeat(LIMITS.textBytes + 1));
  await assert.rejects(f.call("gmail_read_message", { accountId: first.id, messageId: "message-one" }), { code: "gmail_mime_limit" });
  const bytes = Buffer.alloc(600_000, 0xe9);
  f.transport.respond = async () => ({
    ...fullMessage(),
    payload: { ...part(), headers: [{ name: "Content-Type", value: "text/plain; charset=iso-8859-1" }], body: { size: bytes.length, data: bytes.toString("base64url") } },
  });
  await assert.rejects(f.call("gmail_read_message", { accountId: first.id, messageId: "message-one" }), { code: "gmail_mime_limit" });
});

test("thread reads return complete account-labeled messages and reject cross-thread responses", async () => {
  const f = fixture();
  f.transport.respond = async () => ({ id: "thread-one", messages: [fullMessage(), fullMessage("message-two")] });
  const result = await f.call("gmail_read_thread", { accountId: second.id, threadId: "thread-one" });
  assert.equal(result.complete, true);
  assert.equal(result.messages.length, 2);
  assert.ok(result.messages.every((message: any) => message.accountId === second.id && message.email === second.email));
  assert.equal(f.transport.calls[0]!.request.path, "/users/me/threads/thread-one");
  assert.equal(f.transport.calls[0]!.request.expectedGeneration, second.generation);
  f.transport.respond = async () => ({ id: "thread-one", messages: [fullMessage("message-one", "other-thread")] });
  await assert.rejects(f.call("gmail_read_thread", { accountId: second.id, threadId: "thread-one" }), { code: "gmail_invalid_response" });
});

test("attachment reads verify membership, enforce 5 MiB, use only the selected account and never write paths", async () => {
  const f = fixture();
  f.transport.respond = async ({ request }) => request.path.includes("/attachments/") ? { size: 4, data: Buffer.from([0, 1, 2, 255]).toString("base64url") } : addAttachment();
  const result = await f.call("gmail_read_attachment", { accountId: second.id, messageId: "message-one", attachmentId: "attachment-one" });
  assert.equal(result.accountId, second.id);
  assert.equal(result.email, second.email);
  assert.equal(result.encoding, "base64");
  assert.deepEqual(Buffer.from(result.data, "base64"), Buffer.from([0, 1, 2, 255]));
  assert.ok(f.transport.calls.every((call) => call.accountId === second.id));
  assert.equal(f.transport.calls[1]!.request.path, "/users/me/messages/message-one/attachments/attachment-one");
  const calls = f.transport.calls.length;
  await assert.rejects(f.call("gmail_read_attachment", { accountId: second.id, messageId: "message-one", attachmentId: "other-attachment" }), { code: "gmail_attachment_not_found" });
  assert.equal(f.transport.calls.length, calls + 1);
  await assert.rejects(f.call("gmail_read_attachment", { accountId: second.id, messageId: "message-one", attachmentId: "attachment-one", path: "/forbidden" }));
  f.transport.respond = async () => addAttachment(fullMessage(), LIMITS.attachmentBytes + 1);
  await assert.rejects(f.call("gmail_read_attachment", { accountId: second.id, messageId: "message-one", attachmentId: "attachment-one" }), { code: "gmail_attachment_limit" });
  assert.equal(result.path, undefined);
});

test("attachment inline part IDs and missing body data are explicit, malformed attachment bytes fail", async () => {
  const f = fixture();
  f.transport.respond = async () => {
    const message = addAttachment();
    message.payload.parts[1] = { ...message.payload.parts[1]!, body: { size: 4, data: Buffer.from("data").toString("base64url") } } as typeof message.payload.parts[1];
    return message;
  };
  const inline = await f.call("gmail_read_attachment", { accountId: first.id, messageId: "message-one", partId: "1" });
  assert.equal(Buffer.from(inline.data, "base64").toString(), "data");
  assert.equal(f.transport.calls.length, 1);
  f.transport.respond = async ({ request }) => request.path.includes("/attachments/") ? { size: 4, data: "!!!!" } : addAttachment();
  await assert.rejects(f.call("gmail_read_attachment", { accountId: first.id, messageId: "message-one", attachmentId: "attachment-one" }), { code: "gmail_invalid_response" });
  f.transport.respond = async () => ({ ...fullMessage(), payload: { ...part(), body: { size: 99 } } });
  const message = await f.call("gmail_read_message", { accountId: first.id, messageId: "message-one" });
  assert.equal(message.body.incomplete, true);
  assert.equal(message.omittedBodyParts[0].partId, "");
  assert.equal(message.omittedBodyParts[0].downloadable, false);
});

test("attachment limit accepts exactly 5 MiB but rejects false byte counts and mismatched source messages", async () => {
  const f = fixture();
  const bytes = Buffer.alloc(LIMITS.attachmentBytes, 42);
  f.transport.respond = async ({ request }) => request.path.includes("/attachments/")
    ? { size: bytes.length, data: bytes.toString("base64url") }
    : addAttachment(fullMessage(), bytes.length);
  const result = await f.call("gmail_read_attachment", { accountId: first.id, messageId: "message-one", attachmentId: "attachment-one" });
  assert.equal(Buffer.from(result.data, "base64").length, LIMITS.attachmentBytes);
  assert.equal(f.transport.calls[1]!.request.maxBytes, Math.ceil(LIMITS.attachmentBytes / 3) * 4 + 2_048);
  f.transport.respond = async ({ request }) => request.path.includes("/attachments/")
    ? { size: 4, data: Buffer.from("too many bytes").toString("base64url") }
    : addAttachment();
  await assert.rejects(f.call("gmail_read_attachment", { accountId: first.id, messageId: "message-one", attachmentId: "attachment-one" }), { code: "gmail_invalid_response" });
  f.transport.respond = async () => addAttachment(fullMessage("other-message"));
  const before = f.transport.calls.length;
  await assert.rejects(f.call("gmail_read_attachment", { accountId: first.id, messageId: "message-one", attachmentId: "attachment-one" }), { code: "gmail_invalid_response" });
  assert.equal(f.transport.calls.length, before + 1);
});

test("draft composer preserves Unicode names/subject/body, IDNA and Bcc with verified From", async () => {
  const f = fixture();
  f.transport.respond = async () => createdDraft();
  const result = await f.call("gmail_create_draft", draftInput({
    to: [{ email: "user@bücher.example", name: "Zoë, 李" }],
    cc: [{ email: "cc@example.test", name: "José" }],
    bcc: [{ email: "hidden@example.test", name: "秘密" }],
    subject: "こんにちは ✉ café",
    text: "Body résumé\n你好",
  }));
  assert.equal(result.status, "succeeded");
  assert.equal(result.email, first.email);
  assert.equal(result.result.draftId, "draft-one");
  assert.equal(f.transport.calls.length, 1);
  const call = f.transport.calls[0]!;
  assert.equal(call.request.method, "POST");
  assert.equal(call.request.path, "/users/me/drafts");
  assert.equal(call.request.expectedGeneration, first.generation);
  assert.equal(call.request.readOnly, false);
  const payload = call.request.body as { message: { raw: string } };
  assert.deepEqual(Object.keys(payload), ["message"]);
  assert.doesNotMatch(payload.message.raw, /[+/=]/);
  const bytes = Buffer.from(payload.message.raw, "base64url");
  const parsed = await simpleParser(bytes);
  assert.equal(parsed.from!.value[0]!.address, first.email);
  assert.equal((Array.isArray(parsed.to) ? parsed.to[0]! : parsed.to!).value[0]!.address, "user@bücher.example");
  assert.match(bytes.toString(), /user@xn--bcher-kva\.example/);
  assert.equal((Array.isArray(parsed.to) ? parsed.to[0]! : parsed.to!).value[0]!.name, "Zoë, 李");
  assert.equal((Array.isArray(parsed.bcc) ? parsed.bcc[0]! : parsed.bcc!).value[0]!.address, "hidden@example.test");
  assert.equal(parsed.subject, "こんにちは ✉ café");
  assert.equal(parsed.text!.trim(), "Body résumé\n你好");
  assert.match(bytes.toString(), /^Bcc:/m);
  assert.doesNotMatch(JSON.stringify(result), /Body résumé|hidden@example|こんにちは/);
  assert.doesNotMatch(JSON.stringify(f.operations.plans[0]!.preview), /Body résumé|hidden@example/);
});

test("draft idempotency normalizes IDNA, Unicode and line endings; Bcc-only drafts need no read scope", async () => {
  const f = fixture();
  f.accounts.records.get(first.id)!.scopes = [COMPOSE_SCOPE];
  f.transport.respond = async () => createdDraft();
  const original = draftInput({
    to: [], bcc: [{ email: "hidden@bücher.example", name: "Jose\u0301" }],
    subject: "Cafe\u0301", text: "one\r\ntwo\rthree",
  });
  const result = await f.call("gmail_create_draft", original);
  assert.equal(result.status, "succeeded");
  await f.call("gmail_create_draft", {
    ...original, bcc: [{ email: "hidden@XN--BCHER-KVA.EXAMPLE", name: "José" }],
    subject: "Café", text: "one\ntwo\nthree",
  });
  assert.equal(f.transport.calls.length, 1);
  assert.equal(f.operations.prepares, 1);
  const mime = (f.transport.calls[0]!.request.body as { message: { raw: string } }).message.raw;
  const parsed = await simpleParser(Buffer.from(mime, "base64url"));
  assert.ok(parsed.bcc);
  assert.equal(parsed.to, undefined);
  assert.equal(parsed.cc, undefined);
  assert.equal(parsed.text!.trim(), "one\ntwo\nthree");
});

test("recipient, header, body, nested/raw field and size validation rejects injection before reservation", async () => {
  const f = fixture();
  for (const extra of [
    { subject: "subject\r\nBcc: injected@example.test" },
    { subject: "NUL\u0000subject" },
    { to: [{ email: "one@example.test,two@example.test" }] },
    { to: [{ email: "a..b@example.test" }] },
    { to: [{ email: "a@example.test\r\nBcc:bad@example.test" }] },
    { to: [{ email: "a@example.test", name: "Name\nBcc:bad@example.test" }] },
    { to: [{ email: "a@example.test", name: "\u2028injection" }] },
    { to: [{ email: "ü@example.test" }] },
    { to: [{ email: "a@-invalid.test" }] },
    { to: [{ email: "a@example.test/path" }] },
    { to: [{ email: "a@example%2etest" }] },
    { to: [{ email: "a@example.test#ignored" }] },
    { to: [] },
    { text: "nul\u0000body" },
    { text: "\ud800" },
    { text: "😀".repeat(300_000) },
    { subject: "a".repeat(999) },
    { raw: "Content-Type: message/rfc822" },
    { sendAs: "someone@example.test" },
  ]) await assert.rejects(f.call("gmail_create_draft", draftInput(extra)));
  assert.equal(f.operations.prepares, 0);
  assert.equal(f.transport.calls.length, 0);
});

test("reply draft reserves before source reads and derives thread, original subject and RFC references", async () => {
  const f = fixture();
  f.transport.respond = async ({ request }) => {
    assert.equal(f.operations.reserved, true);
    if (request.method === "POST") return createdDraft("source-thread");
    const source = fullMessage("source-message", "source-thread");
    source.payload.headers.push({ name: "References", value: "<ancestor@example.test> <parent@example.test>" });
    source.payload.headers.find((header) => header.name === "Subject")!.value = "=?UTF-8?B?5L2g5aW9?=";
    return source;
  };
  const args = draftInput({ subject: undefined, replyToMessageId: "source-message", to: [{ email: "explicit@example.test" }] });
  const result = await f.call("gmail_create_draft", args);
  assert.equal(result.status, "succeeded");
  assert.equal(f.transport.calls[0]!.request.path, "/users/me/messages/source-message");
  assert.equal(f.transport.calls[0]!.accountId, first.id);
  const message = (f.transport.calls[1]!.request.body as { message: { threadId: string; raw: string } }).message;
  assert.equal(message.threadId, "source-thread");
  const parsed = await simpleParser(Buffer.from(message.raw, "base64url"));
  assert.equal(parsed.subject, "你好");
  assert.equal(parsed.inReplyTo, "<rfc-message@example.test>");
  assert.deepEqual(parsed.references, ["<ancestor@example.test>", "<parent@example.test>", "<rfc-message@example.test>"]);
  assert.equal((Array.isArray(parsed.to) ? parsed.to[0]! : parsed.to!).value.length, 1);
  assert.equal((Array.isArray(parsed.to) ? parsed.to[0]! : parsed.to!).value[0]!.address, "explicit@example.test");
  assert.equal(parsed.cc, undefined);
  await f.call("gmail_create_draft", args);
  assert.equal(f.operations.prepares, 1);
  assert.equal(f.transport.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(f.operations.intents[0]), /raw|rfc-message|source-thread|date/i);
  await assert.rejects(f.call("gmail_create_draft", { ...args, text: "Different text" }), { code: "request_id_conflict" });
});

test("reply drafts emit the source's exact decomposed subject even when a canonical equivalent is supplied", async () => {
  const originalSubject = "Cafe\u0301 — A\u030Angstro\u0308m";
  assert.notEqual(originalSubject, originalSubject.normalize("NFC"));
  for (const suppliedSubject of [undefined, originalSubject, originalSubject.normalize("NFC")]) {
    const f = fixture();
    f.transport.respond = async ({ request }) => {
      if (request.method === "POST") return createdDraft("source-thread");
      const source = fullMessage("source-message", "source-thread");
      source.payload.headers.find((header) => header.name === "Subject")!.value = `=?UTF-8?B?${Buffer.from(originalSubject).toString("base64")}?=`;
      return source;
    };
    await f.call("gmail_create_draft", draftInput({ replyToMessageId: "source-message", subject: suppliedSubject }));
    const message = (f.transport.calls[1]!.request.body as { message: { raw: string; threadId: string } }).message;
    const parsed = await simpleParser(Buffer.from(message.raw, "base64url"));
    assert.equal(message.threadId, "source-thread");
    assert.equal(parsed.subject, originalSubject);
    assert.deepEqual(Buffer.from(parsed.subject!), Buffer.from(originalSubject));
    assert.equal(parsed.inReplyTo, "<rfc-message@example.test>");
  }
});

test("missing, injected, duplicate and malformed reply headers or different subjects never create drafts", async () => {
  for (const mode of ["missing-id", "missing-subject", "bad-id", "multiple-id", "bad-references", "duplicate-id", "wrong-subject", "wrong-message", "header-injection"]) {
    const f = fixture();
    f.transport.respond = async () => {
      const source = fullMessage("source-message");
      if (mode === "missing-id") source.payload.headers = source.payload.headers.filter((header) => header.name !== "Message-ID");
      if (mode === "missing-subject") source.payload.headers = source.payload.headers.filter((header) => header.name !== "Subject");
      if (mode === "bad-id") source.payload.headers.find((header) => header.name === "Message-ID")!.value = "opaque-google-message-id";
      if (mode === "multiple-id") source.payload.headers.find((header) => header.name === "Message-ID")!.value = "<one@example.test> <two@example.test>";
      if (mode === "bad-references") source.payload.headers.push({ name: "References", value: "not-a-message-id" });
      if (mode === "duplicate-id") source.payload.headers.push({ name: "Message-ID", value: "<duplicate@example.test>" });
      if (mode === "wrong-message") source.id = "other-message";
      if (mode === "header-injection") source.payload.headers.find((header) => header.name === "Subject")!.value = "Subject\r\nInjected: header";
      return source;
    };
    await assert.rejects(f.call("gmail_create_draft", draftInput({ replyToMessageId: "source-message", subject: mode === "wrong-subject" ? "Different" : undefined })));
    assert.equal(f.transport.calls.length, 1);
    assert.ok(f.transport.calls.every(({ request }) => request.method === "GET"));
  }
});

test("draft outcomes are never retried and accounts/request receipts remain isolated", async () => {
  const f = fixture();
  f.transport.respond = async () => { throw new ConnectorError("response_lost", "Response lost.", false, { outcomeUnknown: true }); };
  const firstResult = await f.call("gmail_create_draft", draftInput());
  const retry = await f.call("gmail_create_draft", draftInput());
  assert.equal(firstResult.status, "outcome_unknown");
  assert.equal(retry.status, "outcome_unknown");
  assert.equal(f.transport.calls.length, 1);
  f.transport.respond = async () => createdDraft();
  const otherAccount = await f.call("gmail_create_draft", draftInput({ accountId: second.id }));
  assert.equal(otherAccount.email, second.email);
  assert.equal(f.transport.calls.length, 2);
  const mime = (f.transport.calls[1]!.request.body as { message: { raw: string } }).message.raw;
  assert.equal((await simpleParser(Buffer.from(mime, "base64url"))).from!.value[0]!.address, second.email);
  const invalid = fixture();
  invalid.transport.respond = async () => ({ unexpected: "SECRET BODY" });
  assert.equal((await invalid.call("gmail_create_draft", draftInput())).status, "outcome_unknown");
  await invalid.call("gmail_create_draft", draftInput());
  assert.equal(invalid.transport.calls.length, 1);
});

test("missing scopes and unknown accounts fail with identity rather than switching to another account", async () => {
  const f = fixture();
  f.accounts.records.get(first.id)!.scopes = [READ_SCOPE];
  await assert.rejects(f.call("gmail_create_draft", draftInput()), { code: "missing_scopes" });
  f.accounts.records.get(first.id)!.scopes = [COMPOSE_SCOPE];
  await assert.rejects(f.call("gmail_read_message", { accountId: first.id, messageId: "message-one" }), { code: "missing_scopes" });
  const search = await f.call("gmail_search", { accountIds: [first.id, "unknown"], query: "" });
  assert.equal(search.accounts[0].email, first.email);
  assert.equal(search.accounts[0].errors[0].error.code, "missing_scopes");
  assert.equal(search.accounts[1].accountId, "unknown");
  assert.equal(search.accounts[1].email, null);
  assert.equal(search.accounts[1].status, "error");
  await assert.rejects(f.call("gmail_create_draft", draftInput({ replyToMessageId: "message-one" })), { code: "missing_scopes" });
  assert.equal(f.transport.calls.length, 0);
});
