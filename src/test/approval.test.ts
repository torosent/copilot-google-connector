import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  verifyAuthenticationResponse, type AuthenticationResponseJSON, type PublicKeyCredentialRequestOptionsJSON,
  type PublicKeyCredentialCreationOptionsJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { StateStore } from "../core/state.js";
import { digest } from "../core/canonical.js";
import type { ApprovalRequest } from "../core/types.js";
import {
  APPROVAL_ENROLLMENT_KEY, WebAuthnApprovalGateway, type ApprovalDependencies, type EnrollmentRecord,
} from "../approval/index.js";

// These software-generated credentials and injected verifiers are LOCAL TEST
// FAKES. They validate protocol/state handling, not physical human presence.
function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1],
    [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
    [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
  ]));
  const record: EnrollmentRecord = {
    version: 1, rpID: "localhost", generation: randomUUID(), userId: randomBytes(32).toString("base64url"),
    createdAt: 1_800_000_000_000,
    credential: { id: randomBytes(32).toString("base64url"), publicKey: Buffer.from(cose).toString("base64url"), counter: 0, transports: ["internal"] },
    credentialDeviceType: "singleDevice", credentialBackedUp: false,
  };
  return { privateKey, cose, record };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, dependencies: ApprovalDependencies = {}, enrolled = true) {
  const directory = resolve(`.approval-test-${randomUUID()}`);
  const state = new StateStore(directory);
  await state.initialize();
  const key = authenticator();
  if (enrolled) await state.write(APPROVAL_ENROLLMENT_KEY, key.record);
  let now = 1_800_000_000_000;
  const gateway = new WebAuthnApprovalGateway(state, { now: () => now, ...dependencies });
  t.after(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  let writes = 0;
  let cancellations = 0;
  function proposal(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
    const operationId = randomUUID();
    return {
      operationId, accountId: "account-one", accountGeneration: "account-generation-one",
      digest: digest({ operationId, action: "calendar.delete" }), expiresAt: now + 300_000,
      preview: {
        account: { id: "account-one", email: "one@example.test" }, calendar: "primary", action: "delete",
        before: { summary: "Full server-owned title", attendees: [{ email: "guest@example.test" }] },
        after: null, scope: "series", recurrence: ["RRULE:FREQ=WEEKLY"], sendUpdates: "all",
        notificationEffects: "Notify all guests", exceptionEffects: "Bounded exceptions listed",
      },
      approve: async () => { writes++; return { status: "succeeded", privateResult: "not an HTTP response" }; },
      cancel: async () => { cancellations++; return { status: "cancelled" }; },
      ...overrides,
    };
  }
  return {
    directory, state, key, gateway, proposal, now: () => now, advance: (ms: number) => { now += ms; },
    writes: () => writes, cancellations: () => cancellations,
  };
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json<T = Record<string, unknown>>(): T;
}

function http(
  url: string, suffix = "", body?: unknown,
  options: { headers?: Record<string, string | string[] | undefined>; method?: string; rawBody?: string } = {},
): Promise<HttpResult> {
  const parsed = new URL(url);
  const bytes = options.rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  const method = options.method ?? (bytes === undefined ? "GET" : "POST");
  const headers: Record<string, string | string[] | undefined> = { Host: parsed.host };
  if (bytes !== undefined) {
    headers.Origin = parsed.origin;
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(bytes));
  }
  Object.assign(headers, options.headers);
  for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
  return new Promise<HttpResult>((done, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1", port: parsed.port, path: parsed.pathname + suffix, method, headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        done({ status: response.statusCode!, headers: response.headers, text, json: <T>() => JSON.parse(text) as T });
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error("Local test HTTP request timed out.")));
    request.on("error", reject);
    request.end(bytes);
  });
}

async function options(url: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const response = await http(url, "/options", {});
  assert.equal(response.status, 200, response.text);
  return response.json<PublicKeyCredentialRequestOptionsJSON>();
}

function assertion(
  key: ReturnType<typeof authenticator>, options: PublicKeyCredentialRequestOptionsJSON, origin: string,
  overrides: { flags?: number; rpID?: string; counter?: number; client?: Record<string, unknown>; id?: string; userHandle?: string } = {},
): AuthenticationResponseJSON {
  const client = Buffer.from(JSON.stringify({
    type: "webauthn.get", origin, challenge: options.challenge, crossOrigin: false, ...overrides.client,
  }));
  const header = Buffer.alloc(5);
  header[0] = overrides.flags ?? 0x05;
  header.writeUInt32BE(overrides.counter ?? 0, 1);
  const authData = Buffer.concat([createHash("sha256").update(overrides.rpID ?? "localhost").digest(), header]);
  const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(client).digest()]), key.privateKey);
  return {
    id: overrides.id ?? key.record.credential.id, rawId: overrides.id ?? key.record.credential.id,
    type: "public-key", clientExtensionResults: {},
    response: {
      clientDataJSON: client.toString("base64url"), authenticatorData: authData.toString("base64url"),
      signature: signature.toString("base64url"),
      ...(overrides.userHandle === undefined ? {} : { userHandle: overrides.userHandle }),
    },
  };
}

function registration(
  key: ReturnType<typeof authenticator>, options: PublicKeyCredentialCreationOptionsJSON, origin: string,
  overrides: { flags?: number; rpID?: string; client?: Record<string, unknown> } = {},
): RegistrationResponseJSON {
  const id = Buffer.from(key.record.credential.id, "base64url");
  const header = Buffer.alloc(5);
  header[0] = overrides.flags ?? 0x45;
  const length = Buffer.alloc(2);
  length.writeUInt16BE(id.length);
  const authData = Buffer.concat([
    createHash("sha256").update(overrides.rpID ?? "localhost").digest(), header, Buffer.alloc(16), length, id, key.cose,
  ]);
  const attestation = isoCBOR.encode(new Map<string, string | Uint8Array | Map<number, never>>([
    ["fmt", "none"], ["authData", new Uint8Array(authData)], ["attStmt", new Map<number, never>()],
  ]));
  return {
    id: key.record.credential.id, rawId: key.record.credential.id, type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: Buffer.from(JSON.stringify({
        type: "webauthn.create", origin, challenge: options.challenge, crossOrigin: false, ...overrides.client,
      })).toString("base64url"),
      attestationObject: Buffer.from(attestation).toString("base64url"), transports: ["internal"],
    },
  };
}

test("unconfigured service fails closed and never exposes enrollment or opens a browser", async (t) => {
  let opened = 0;
  const f = await fixture(t, { openBrowser: async () => { opened++; } }, false);
  await assert.rejects(f.gateway.request(f.proposal()), /existing enrolled authenticator/);
  await assert.rejects(f.gateway.enroll(), /separate/);
  assert.equal(opened, 0);
  assert.equal(f.writes(), 0);
  assert.equal(await f.state.read(APPROVAL_ENROLLMENT_KEY), undefined);
});

test("malformed, null and structurally corrupt enrollment are never absence", async (t) => {
  for (const value of [null, {}, { version: 1, credential: {} }]) {
    const f = await fixture(t, {}, false);
    await f.state.write(APPROVAL_ENROLLMENT_KEY, value);
    await assert.rejects(f.gateway.request(f.proposal()), /invalid/);
    const bootstrap = new WebAuthnApprovalGateway(f.state);
    await assert.rejects(bootstrap.enroll(), /invalid/);
    assert.deepEqual(await f.state.read(APPROVAL_ENROLLMENT_KEY), value);
  }
  const f = await fixture(t);
  await writeFile(join(f.directory, `${APPROVAL_ENROLLMENT_KEY}.json`), "{broken", { mode: 0o600 });
  await assert.rejects(f.gateway.request(f.proposal()), /Cannot read local state/);
  await assert.rejects(new WebAuthnApprovalGateway(f.state).enroll(), /Cannot read local state/);
});

test("invalid persisted public keys fail before displaying a review or offering enrollment", async (t) => {
  const f = await fixture(t);
  await f.state.write(APPROVAL_ENROLLMENT_KEY, {
    ...f.key.record, credential: { ...f.key.record.credential, publicKey: "AAAA" },
  });
  await assert.rejects(f.gateway.request(f.proposal()), /invalid/);
  await assert.rejects(new WebAuthnApprovalGateway(f.state).enroll(), /invalid/);
});

test("review displays the complete frozen manifest as escaped text with restrictive headers", async (t) => {
  const f = await fixture(t);
  const input = f.proposal();
  input.preview.maliciousTitle = '<script>alert("mail")</script><img src=x onerror="steal()">\u202e';
  const url = await f.gateway.request(input);
  input.accountId = "changed-account";
  input.preview.after = { summary: "changed payload" };
  const response = await http(url);
  assert.equal(response.status, 200);
  assert.match(response.text, /account-one/);
  assert.match(response.text, /one@example.test/);
  assert.match(response.text, /guest@example.test/);
  assert.match(response.text, /RRULE:FREQ=WEEKLY/);
  assert.match(response.text, /sendUpdates/);
  assert.match(response.text, /&lt;script&gt;alert/);
  assert.match(response.text, /\\u202e/);
  assert.doesNotMatch(response.text, /\u202e/);
  assert.doesNotMatch(response.text, /<script>alert|changed-account|changed payload/);
  assert.match(String(response.headers["content-security-policy"]), /default-src 'none'/);
  assert.match(String(response.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.match(String(response.headers["permissions-policy"]), /publickey-credentials-create=\(\)/);
  const script = await http(`${new URL(url).origin}/assets/approval.js`);
  assert.match(script.text, /navigator\.credentials\.get/);
  assert.match(script.text, /navigator\.credentials\.create/);
  assert.doesNotMatch(script.text, /innerHTML|https:\/\//);
  assert.equal((await http(`${new URL(url).origin}/enroll/${"a".repeat(32)}`)).status, 404);
  assert.equal(f.writes(), 0);
});

test("operation ID reuse cannot substitute account, generation, digest or preview", async (t) => {
  const f = await fixture(t);
  const input = f.proposal();
  const url = await f.gateway.request(input);
  assert.equal(await f.gateway.request({ ...input }), url);
  for (const change of [
    { accountId: "account-two" }, { accountGeneration: "changed" },
    { digest: "f".repeat(64) }, { preview: { action: "new" } }, { expiresAt: input.expiresAt + 1 },
  ]) await assert.rejects(f.gateway.request({ ...input, ...change }), /different immutable/);
  await assert.rejects(f.gateway.request(f.proposal({ preview: { oversized: "x".repeat(1024 * 1024) } })), /manifest exceeds/);
});

test("direct HTTP booleans and capability claims cannot authorize a write", async (t) => {
  const f = await fixture(t);
  const url = await f.gateway.request(f.proposal());
  for (const body of [
    { approved: true }, { confirmed: true }, { capability: { humanApproved: true } },
    { response: { verified: true, userVerified: true } },
  ]) assert.equal((await http(url, "/verify", body)).status, 400);
  assert.equal((await http(url, "/options", { confirmed: true })).status, 400);
  assert.equal((await http(url, "/verify", {}, { method: "GET" })).status, 405);
  assert.equal(f.writes(), 0);
  assert.equal((await f.state.read<EnrollmentRecord>(APPROVAL_ENROLLMENT_KEY))!.credential.counter, 0);
});

test("exact Host and Origin, methods, paths, media types and body limits are enforced", async (t) => {
  const f = await fixture(t);
  const url = await f.gateway.request(f.proposal());
  const origin = new URL(url).origin;
  for (const headers of [
    { Host: "evil.example" }, { Host: `127.0.0.1:${new URL(url).port}` },
    { Origin: "https://evil.example" }, { Origin: `${origin}/` }, { Origin: undefined },
    { Origin: [origin, origin] }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Dest": "iframe" },
  ]) assert.equal((await http(url, "/options", {}, { headers })).status, 403);
  assert.equal((await http(url, "", undefined, { headers: { Host: "LOCALHOST:" + new URL(url).port } })).status, 403);
  assert.equal((await http(url, "/options", {}, { method: "OPTIONS" })).status, 405);
  assert.equal((await http(url, "?override=another")).status, 404);
  assert.equal((await http(url, "/options", {}, { headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await http(url, "/options", {}, { headers: { "Content-Encoding": "gzip" } })).status, 415);
  assert.equal((await http(url, "/options", undefined, { rawBody: "{broken" })).status, 400);
  assert.equal((await http(url, "/options", { junk: "x".repeat(65_536) })).status, 413);
  assert.equal((await http(url, "/options", {}, { headers: { "Content-Type": "application/json; charset=utf-8" } })).status, 200);
  assert.equal(f.writes(), 0);
});

test("real verifier accepts a locally signed UP+UV assertion once and persists its counter", async (t) => {
  const f = await fixture(t);
  const url = await f.gateway.request(f.proposal());
  const opts = await options(url);
  assert.equal(opts.rpId, "localhost");
  assert.equal(opts.userVerification, "required");
  assert.equal(opts.timeout, 120_000);
  assert.deepEqual(opts.allowCredentials, [{ id: f.key.record.credential.id, transports: ["internal"], type: "public-key" }]);
  assert.equal(Buffer.from(opts.challenge, "base64url").length, 64);
  const signed = assertion(f.key, opts, new URL(url).origin, { counter: 1, userHandle: f.key.record.userId });
  const response = await http(url, "/verify", { response: signed });
  assert.equal(response.status, 200, response.text);
  assert.doesNotMatch(response.text, /privateResult|not an HTTP response/);
  assert.equal(f.writes(), 1);
  assert.equal((await f.state.read<EnrollmentRecord>(APPROVAL_ENROLLMENT_KEY))!.credential.counter, 1);
  assert.equal((await http(url, "/verify", { response: signed })).status, 409);
  assert.equal((await http(url, "/options", {})).status, 409);
  assert.equal(f.writes(), 1);
});

test("legitimate zero counters remain supported on distinct fresh operations", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 2; index++) {
    const url = await f.gateway.request(f.proposal());
    const signed = assertion(f.key, await options(url), new URL(url).origin);
    assert.equal((await http(url, "/verify", { response: signed })).status, 200);
  }
  assert.equal(f.writes(), 2);
  assert.equal((await f.state.read<EnrollmentRecord>(APPROVAL_ENROLLMENT_KEY))!.credential.counter, 0);
});

test("invalid signed UP/UV, RP, origin, type, challenge, credential and signature all fail closed", async (t) => {
  const f = await fixture(t);
  const url = await f.gateway.request(f.proposal());
  const variants: Array<Parameters<typeof assertion>[3]> = [
    { flags: 1 }, { flags: 4 }, { flags: 0 }, { rpID: "evil.example" },
    { client: { origin: "https://evil.example" } }, { client: { type: "webauthn.create" } },
    { client: { challenge: randomBytes(64).toString("base64url") } }, { client: { crossOrigin: true } },
    { client: { topOrigin: "https://evil.example" } }, { id: randomBytes(32).toString("base64url") },
    { userHandle: randomBytes(32).toString("base64url") },
  ];
  for (const variant of variants) {
    const signed = assertion(f.key, await options(url), new URL(url).origin, variant);
    assert.equal((await http(url, "/verify", { response: signed })).status, 400, JSON.stringify(variant));
  }
  for (const field of ["signature", "authenticatorData", "clientDataJSON"] as const) {
    const signed = assertion(f.key, await options(url), new URL(url).origin);
    signed.response[field] = "AA";
    assert.equal((await http(url, "/verify", { response: signed })).status, 400);
  }
  const virtualKey = authenticator();
  const impostor = assertion(virtualKey, await options(url), new URL(url).origin, { id: f.key.record.credential.id });
  assert.equal((await http(url, "/verify", { response: impostor })).status, 400);
  assert.equal(f.writes(), 0);
});

test("assertions cannot cross accounts, operations or a superseding challenge", async (t) => {
  const f = await fixture(t);
  const first = await f.gateway.request(f.proposal());
  const second = await f.gateway.request(f.proposal({ accountId: "account-two", accountGeneration: "generation-two" }));
  const firstOptions = await options(first);
  const secondOptions = await options(second);
  assert.notEqual(firstOptions.challenge, secondOptions.challenge);
  assert.notEqual(Buffer.from(firstOptions.challenge, "base64url").subarray(32).toString("hex"), Buffer.from(secondOptions.challenge, "base64url").subarray(32).toString("hex"));
  const signed = assertion(f.key, firstOptions, new URL(first).origin);
  assert.equal((await http(second, "/verify", { response: signed })).status, 400);
  await options(first);
  assert.equal((await http(first, "/verify", { response: signed })).status, 400);
  assert.equal(f.writes(), 0);
});

test("enrollment replacement or deletion invalidates captured pending work", async (t) => {
  for (const change of ["generation", "key", "deletion"] as const) {
    const f = await fixture(t);
    const url = await f.gateway.request(f.proposal());
    const signed = assertion(f.key, await options(url), new URL(url).origin);
    await f.state.withLock(APPROVAL_ENROLLMENT_KEY, async () => {
      if (change === "deletion") await f.state.remove(APPROVAL_ENROLLMENT_KEY);
      else await f.state.write(APPROVAL_ENROLLMENT_KEY, change === "generation"
        ? { ...f.key.record, generation: randomUUID() }
        : { ...f.key.record, credential: authenticator().record.credential });
    });
    assert.equal((await http(url, "/verify", { response: signed })).status, 409);
    assert.equal(f.writes(), 0);
  }
});

test("proposal TTL is at most five minutes and assertion TTL at most two minutes", async (t) => {
  const f = await fixture(t);
  const url = await f.gateway.request(f.proposal({ expiresAt: f.now() + 600_000 }));
  const signed = assertion(f.key, await options(url), new URL(url).origin);
  f.advance(120_000);
  assert.equal((await http(url, "/verify", { response: signed })).status, 410);
  assert.equal((await http(url, "/options", {})).status, 200);
  f.advance(180_000);
  assert.equal((await http(url, "/options", {})).status, 410);
  assert.equal(f.writes(), 0);
  assert.equal(f.cancellations(), 1);
  await assert.rejects(f.gateway.request(f.proposal({ expiresAt: f.now() })), /expired/);
});

test("cancellation is one-shot, calls the parent, and invalidates even a valid assertion", async (t) => {
  const f = await fixture(t);
  const url = await f.gateway.request(f.proposal());
  const signed = assertion(f.key, await options(url), new URL(url).origin);
  assert.equal((await http(url, "/cancel", {})).status, 200);
  assert.equal((await http(url, "/cancel", {})).status, 409);
  assert.equal((await http(url, "/verify", { response: signed })).status, 409);
  assert.equal(f.writes(), 0);
  assert.equal(f.cancellations(), 1);
});

test("cancel while the verifier is awaiting prevents claim and dispatch", async (t) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const f = await fixture(t, { verifyAuthentication: async (input) => {
    entered.resolve(); await release.promise; return verifyAuthenticationResponse(input);
  } });
  const url = await f.gateway.request(f.proposal());
  const signed = assertion(f.key, await options(url), new URL(url).origin);
  const verification = http(url, "/verify", { response: signed });
  await entered.promise;
  assert.equal((await http(url, "/cancel", {})).status, 200);
  release.resolve();
  assert.equal((await verification).status, 409);
  assert.equal(f.writes(), 0);
  assert.equal(f.cancellations(), 1);
});

test("challenge expiry while the verifier is awaiting prevents claim", async (t) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const f = await fixture(t, { verifyAuthentication: async (input) => {
    entered.resolve(); await release.promise; return verifyAuthenticationResponse(input);
  } });
  const url = await f.gateway.request(f.proposal());
  const signed = assertion(f.key, await options(url), new URL(url).origin);
  const verification = http(url, "/verify", { response: signed });
  await entered.promise;
  f.advance(120_000);
  release.resolve();
  assert.equal((await verification).status, 410);
  assert.equal(f.writes(), 0);
});

test("concurrent replay admits exactly one verifier and one parent callback", async (t) => {
  let verifications = 0;
  const f = await fixture(t, { verifyAuthentication: async (input) => {
    verifications++; return verifyAuthenticationResponse(input);
  } });
  const url = await f.gateway.request(f.proposal());
  const signed = assertion(f.key, await options(url), new URL(url).origin);
  const responses = await Promise.all([http(url, "/verify", { response: signed }), http(url, "/verify", { response: signed })]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(verifications, 1);
  assert.equal(f.writes(), 1);
});

test("counter updates are serialized across independent gateway instances", async (t) => {
  const f = await fixture(t);
  const other = new WebAuthnApprovalGateway(new StateStore(f.directory), { now: f.now });
  t.after(() => other.close());
  const one = await f.gateway.request(f.proposal());
  const two = await other.request(f.proposal());
  const signedOne = assertion(f.key, await options(one), new URL(one).origin, { counter: 1 });
  const signedTwo = assertion(f.key, await options(two), new URL(two).origin, { counter: 1 });
  const responses = await Promise.all([
    http(one, "/verify", { response: signedOne }), http(two, "/verify", { response: signedTwo }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
  assert.equal(f.writes(), 1);
});

test("cancel and shutdown do not automatically cancel an already claimed callback", async (t) => {
  const f = await fixture(t);
  const entered = deferred<void>();
  const release = deferred<void>();
  let finished = false;
  const url = await f.gateway.request(f.proposal({ approve: async () => {
    entered.resolve(); await release.promise; finished = true; return {};
  } }));
  const signed = assertion(f.key, await options(url), new URL(url).origin);
  const verification = http(url, "/verify", { response: signed }).catch(() => undefined);
  await entered.promise;
  assert.equal((await http(url, "/cancel", {})).status, 409);
  await f.gateway.close();
  assert.equal(f.cancellations(), 0);
  release.resolve();
  await verification;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, true);
});

test("shutdown before claim cancels proposals and closes the listener", async (t) => {
  const f = await fixture(t);
  const url = await f.gateway.request(f.proposal());
  await f.gateway.close();
  await assert.rejects(http(url));
  assert.equal(f.cancellations(), 1);
  assert.equal(f.writes(), 0);
});

test("parent dispatch errors cannot leak provider data or reopen a claimed approval", async (t) => {
  const f = await fixture(t);
  let claims = 0;
  const url = await f.gateway.request(f.proposal({ approve: async () => {
    claims++; throw new Error("SECRET_GOOGLE_TOKEN");
  } }));
  const signed = assertion(f.key, await options(url), new URL(url).origin);
  const response = await http(url, "/verify", { response: signed });
  assert.equal(response.status, 409);
  assert.doesNotMatch(response.text, /SECRET_GOOGLE_TOKEN/);
  assert.equal((await http(url, "/verify", { response: signed })).status, 409);
  assert.equal(claims, 1);
});

test("LOCAL FAKE verifier injection exercises state flow without a production bypass", async (t) => {
  let called = 0;
  const f = await fixture(t, { verifyAuthentication: async (input) => {
    called++;
    assert.equal(input.requireUserVerification, true);
    assert.equal(input.advancedFIDOConfig, undefined);
    assert.equal(input.expectedType, "webauthn.get");
    assert.equal(input.expectedRPID, "localhost");
    assert.deepEqual(Buffer.from(input.credential.publicKey), Buffer.from(f.key.cose));
    return { verified: true, authenticationInfo: {
      credentialID: input.credential.id, newCounter: 0, userVerified: true,
      credentialDeviceType: "singleDevice", credentialBackedUp: false,
      origin: input.expectedOrigin as string, rpID: "localhost",
    } };
  } });
  const url = await f.gateway.request(f.proposal());
  const missingPresence = assertion(f.key, await options(url), new URL(url).origin, { flags: 4 });
  assert.equal((await http(url, "/verify", { response: missingPresence })).status, 400);
  assert.equal(called, 0);
  const signed = assertion(f.key, await options(url), new URL(url).origin);
  signed.response.signature = "AA"; // Deliberately not a valid authenticator signature.
  assert.equal((await http(url, "/verify", { response: signed })).status, 200);
  assert.equal(called, 1);
  assert.equal(f.writes(), 1);
});

test("counter persistence failure prevents the parent callback", async (t) => {
  const f = await fixture(t);
  const failing = new class extends StateStore {
    override async write(): Promise<void> { throw new Error("Injected persistence failure"); }
  }(f.directory);
  const gateway = new WebAuthnApprovalGateway(failing, { now: f.now });
  t.after(() => gateway.close());
  const url = await gateway.request(f.proposal());
  const signed = assertion(f.key, await options(url), new URL(url).origin, { counter: 1 });
  assert.equal((await http(url, "/verify", { response: signed })).status, 400);
  assert.equal(f.writes(), 0);
});

test("explicit enrollment uses real verifier with a local software attestation and cannot repeat", async (t) => {
  const opened = deferred<string>();
  const f = await fixture(t, { openBrowser: async (url) => opened.resolve(url) }, false);
  const completion = f.gateway.enroll();
  const url = await opened.promise;
  const page = await http(url);
  assert.equal(page.status, 200);
  assert.match(page.text, /trusted initial setup/i);
  assert.match(String(page.headers["permissions-policy"]), /publickey-credentials-create=\(self\)/);
  const opts = (await http(url, "/options", {})).json<PublicKeyCredentialCreationOptionsJSON>();
  assert.equal(opts.authenticatorSelection?.userVerification, "required");
  assert.equal(opts.rp.id, "localhost");
  assert.equal(Buffer.from(opts.challenge, "base64url").length, 64);
  const response = await http(url, "/verify", { response: registration(f.key, opts, new URL(url).origin) });
  assert.equal(response.status, 200, response.text);
  const result = await completion;
  assert.equal(result.status, "enrolled");
  const stored = (await f.state.read<EnrollmentRecord>(APPROVAL_ENROLLMENT_KEY))!;
  assert.equal(stored.generation, result.credentialGeneration);
  assert.equal(stored.credential.id, f.key.record.credential.id);
  assert.equal(stored.userId, opts.user.id);
  await assert.rejects(http(url));
  await assert.rejects(new WebAuthnApprovalGateway(f.state).enroll(), /already enrolled/);
  assert.equal(f.writes(), 0);
});

test("enrollment denies invalid UP/UV, origin, RP, challenge and cross-origin data without persistence", async (t) => {
  const opened = deferred<string>();
  const f = await fixture(t, { openBrowser: async (url) => opened.resolve(url) }, false);
  const completion = f.gateway.enroll().catch((error: unknown) => error);
  const url = await opened.promise;
  for (const variant of [
    { flags: 0x41 }, { flags: 0x44 }, { rpID: "evil.example" }, { client: { crossOrigin: true } },
    { client: { origin: "https://evil.example" } }, { client: { challenge: "wrong" } },
    { client: { type: "webauthn.get" } },
  ]) {
    const opts = (await http(url, "/options", {})).json<PublicKeyCredentialCreationOptionsJSON>();
    assert.equal((await http(url, "/verify", { response: registration(f.key, opts, new URL(url).origin, variant) })).status, 400);
  }
  assert.equal(await f.state.read(APPROVAL_ENROLLMENT_KEY), undefined);
  assert.equal((await http(url, "/cancel", {})).status, 200);
  assert.ok(await completion instanceof Error);
  assert.equal(f.writes(), 0);
});

test("concurrent trusted bootstrap instances compare-and-swap truly absent enrollment", async (t) => {
  const firstOpened = deferred<string>();
  const secondOpened = deferred<string>();
  const f = await fixture(t, { openBrowser: async (url) => firstOpened.resolve(url) }, false);
  const other = new WebAuthnApprovalGateway(new StateStore(f.directory), { now: f.now, openBrowser: async (url) => secondOpened.resolve(url) });
  t.after(() => other.close());
  const oneCompletion = f.gateway.enroll().catch((error: unknown) => error);
  const twoCompletion = other.enroll().catch((error: unknown) => error);
  const [one, two] = await Promise.all([firstOpened.promise, secondOpened.promise]);
  const oneOptions = (await http(one, "/options", {})).json<PublicKeyCredentialCreationOptionsJSON>();
  const twoOptions = (await http(two, "/options", {})).json<PublicKeyCredentialCreationOptionsJSON>();
  const otherKey = authenticator();
  const responses = await Promise.all([
    http(one, "/verify", { response: registration(f.key, oneOptions, new URL(one).origin) }),
    http(two, "/verify", { response: registration(otherKey, twoOptions, new URL(two).origin) }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
  await Promise.all([f.gateway.close(), other.close()]);
  const completions = await Promise.all([oneCompletion, twoCompletion]);
  assert.equal(completions.filter((result) => result instanceof Error).length, 1);
  const stored = (await f.state.read<EnrollmentRecord>(APPROVAL_ENROLLMENT_KEY))!;
  assert.ok([f.key.record.credential.id, otherKey.record.credential.id].includes(stored.credential.id));
});

test("browser unavailability and enrollment challenge expiry do not persist enrollment", async (t) => {
  const unavailable = await fixture(t, { openBrowser: async () => { throw new Error("Browser unavailable"); } }, false);
  await assert.rejects(unavailable.gateway.enroll(), /Browser unavailable/);
  assert.equal(await unavailable.state.read(APPROVAL_ENROLLMENT_KEY), undefined);
  const opened = deferred<string>();
  const f = await fixture(t, { openBrowser: async (url) => opened.resolve(url) }, false);
  const completion = f.gateway.enroll().catch((error: unknown) => error);
  const url = await opened.promise;
  const opts = (await http(url, "/options", {})).json<PublicKeyCredentialCreationOptionsJSON>();
  f.advance(120_000);
  assert.equal((await http(url, "/verify", { response: registration(f.key, opts, new URL(url).origin) })).status, 410);
  f.advance(180_000);
  assert.equal((await http(url, "/options", {})).status, 410);
  assert.ok(await completion instanceof Error);
  assert.equal(await f.state.read(APPROVAL_ENROLLMENT_KEY), undefined);
});
