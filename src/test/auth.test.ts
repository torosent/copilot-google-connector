import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { StateStore } from "../core/state.js";
import { ConnectorError, publicError } from "../core/errors.js";
import { AccountManager } from "../auth/accounts.js";
import { GOOGLE_CERTS_URL, GOOGLE_SCOPES, GOOGLE_TOKEN_URL } from "../auth/constants.js";
import { createPkce, GoogleOAuth, receiveAuthorizationCode, type OAuthGrant, type OAuthProvider } from "../auth/oauth.js";
import { NativeVault, SecretServiceVault, type Vault } from "../auth/vault.js";
import { AuthenticatedGoogleTransport, validateGoogleRequest } from "../auth/transport.js";
import { createGmailTools } from "../gmail/index.js";

class MemoryVault implements Vault {
  entries = new Map<string, string>();
  deleted: string[] = [];
  failRead = false;
  failDelete = false;
  async get(key: string) {
    if (this.failRead) throw new ConnectorError("vault_unavailable", "Vault unavailable.");
    return this.entries.get(key);
  }
  async set(key: string, value: string) { this.entries.set(key, value); }
  async delete(key: string) {
    if (this.failDelete) throw new Error("sensitive-secret");
    this.deleted.push(key);
    this.entries.delete(key);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function grant(subject = "google-subject-one", token = "refresh-one"): OAuthGrant {
  return {
    identity: { subject, email: `${subject}@example.test` },
    accessToken: `access-${subject}`, refreshToken: token,
    expiresAt: Date.now() + 3_600_000, scopes: [...GOOGLE_SCOPES],
  };
}
function code(error: unknown, expected: string): boolean { return error instanceof ConnectorError && error.code === expected; }

async function fixture(t: { after(fn: () => Promise<void>): void }, oauth?: OAuthProvider) {
  const directory = join(process.cwd(), `.auth-fixture-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = new StateStore(join(directory, "state"));
  const vault = new MemoryVault();
  const provider = oauth ?? { authorize: async () => grant(), refresh: async () => grant() };
  const accounts = new AccountManager(state, vault, { oauth: provider });
  const file = join(directory, "desktop-client.json");
  await writeFile(file, JSON.stringify({ installed: {
    client_id: "test-client.apps.googleusercontent.com", client_secret: "desktop-client-secret",
    auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token",
    redirect_uris: ["http://localhost"],
  } }), { mode: 0o600 });
  const client = await accounts.importClient(file);
  return { directory, state, vault, accounts, provider, file, client };
}

test("PKCE uses independent 256-bit verifier and S256 challenge", () => {
  const first = createPkce();
  const second = createPkce();
  assert.match(first.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.challenge, createHash("sha256").update(first.verifier).digest("base64url"));
  assert.notEqual(first.verifier, second.verifier);
});

test("Gmail thread tool works through the real transport's response-size contract", async (t) => {
  const f = await fixture(t);
  const account = await f.accounts.add();
  let fetches = 0;
  const transport = new AuthenticatedGoogleTransport(f.accounts, {
    fetch: async (url) => {
      fetches++;
      assert.equal(new URL(url).pathname, "/gmail/v1/users/me/threads/thread1");
      return new Response(JSON.stringify({
        id: "thread1",
        messages: [{
          id: "message1", threadId: "thread1",
          payload: {
            mimeType: "text/plain", partId: "", filename: "",
            headers: [{ name: "Subject", value: "Thread" }],
            body: { size: 2, data: Buffer.from("Hi").toString("base64url") },
          },
        }],
      }), { status: 200 });
    },
  });
  const tools = createGmailTools({
    accounts: f.accounts, transport,
    operations: { submit: async () => { throw new Error("A thread read cannot submit a mutation."); } },
  });
  const thread = tools.find((tool) => tool.name === "gmail_read_thread")!;
  const result = await thread.handler({ accountId: account.id, threadId: "thread1" }) as { complete: boolean; messages: { body: { text: string } }[] };
  assert.equal(result.complete, true);
  assert.equal(result.messages[0]?.body.text, "Hi");
  assert.equal(fetches, 1);
});

test("loopback authorization binds before opening and validates state, PKCE, and offline scopes", async () => {
  let callback = "";
  let observed: URL | undefined;
  const result = await receiveAuthorizationCode("test-client.apps.googleusercontent.com", {
    open: async (authorization) => {
      observed = new URL(authorization);
      callback = observed.searchParams.get("redirect_uri")!;
      assert.equal(new URL(callback).hostname, "127.0.0.1");
      assert.equal(observed.searchParams.get("code_challenge_method"), "S256");
      assert.equal(observed.searchParams.get("access_type"), "offline");
      assert.equal(observed.searchParams.get("prompt"), "consent select_account");
      assert.deepEqual(observed.searchParams.get("scope")!.split(" "), [...GOOGLE_SCOPES]);
      assert.notEqual(observed.searchParams.get("state"), observed.searchParams.get("nonce"));
      assert.equal(observed.searchParams.has("client_secret"), false);
      await fetch(`${callback}?state=${observed.searchParams.get("state")}&code=authorization-code`).then((response) => response.text());
    },
    timeoutMs: 1000,
  });
  assert.equal(result.code, "authorization-code");
  assert.equal(observed!.searchParams.get("code_challenge"), createHash("sha256").update(result.verifier).digest("base64url"));
  assert.equal(result.nonce, observed!.searchParams.get("nonce"));
  await assert.rejects(fetch(callback));
});

test("OAuth denial requires matching state and callback duplicates/host/path are rejected", async () => {
  for (const scenario of ["denial-state", "denial", "duplicate", "empty-error", "host", "path"]) {
    let callback = "";
    const expected = scenario === "denial-state" ? "oauth_state_mismatch" : scenario === "denial" ? "oauth_consent_denied" : "oauth_callback_invalid";
    await assert.rejects(receiveAuthorizationCode("client", {
      open: async (authorization) => {
        const url = new URL(authorization);
        callback = url.searchParams.get("redirect_uri")!;
        const state = url.searchParams.get("state")!;
        const suffix = scenario === "denial-state" ? "?error=access_denied&state=wrong"
          : scenario === "denial" ? `?error=access_denied&state=${state}`
          : scenario === "duplicate" ? `?code=a&code=b&state=${state}`
          : scenario === "empty-error" ? `?code=a&error=&state=${state}`
          : `?code=a&state=${state}`;
        if (scenario === "host") {
          await new Promise<void>((resolve) => {
            const request = httpRequest(callback + suffix, { headers: { Host: "malicious.example" } }, (response) => {
              response.resume();
              response.on("end", resolve);
            });
            request.on("error", () => resolve());
            request.end();
          });
        } else {
          await fetch((scenario === "path" ? callback.replace("/oauth2/callback", "/other") : callback) + suffix).catch(() => undefined);
        }
      },
      timeoutMs: 1000,
    }), (error) => code(error, expected));
    await assert.rejects(fetch(callback));
  }
});

test("OAuth browser failures, cancellation and timeout clean up their listeners without leaking errors", async () => {
  for (const scenario of ["browser", "timeout", "cancel"]) {
    let callback = "";
    const signal = new AbortController();
    await assert.rejects(receiveAuthorizationCode("client", {
      open: async (authorization) => {
        callback = new URL(authorization).searchParams.get("redirect_uri")!;
        if (scenario === "browser") throw new Error("client-secret-in-error");
        if (scenario === "cancel") signal.abort();
      },
      timeoutMs: 30, signal: signal.signal,
    }), (error) => {
      assert.doesNotMatch(JSON.stringify(publicError(error)), /client-secret-in-error/);
      return code(error, scenario === "browser" ? "browser_open_failed" : scenario === "timeout" ? "oauth_timeout" : "oauth_cancelled");
    });
    await assert.rejects(fetch(callback));
  }
});

test("Google ID token verification checks real signatures, issuer, audience, expiry, nonce, email and subject", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const { privateKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "https://accounts.google.com", aud: "client.apps.googleusercontent.com",
    sub: "subject", email: "verified@example.test", email_verified: true,
    nonce: "expected-nonce", iat: now, exp: now + 300,
  };
  const jwt = (changes: Record<string, unknown> = {}, key = privateKey) => {
    const data = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-one", typ: "JWT" })).toString("base64url")
      + "." + Buffer.from(JSON.stringify({ ...payload, ...changes })).toString("base64url");
    return data + "." + sign("RSA-SHA256", Buffer.from(data), key).toString("base64url");
  };
  const oauth = new GoogleOAuth({ fetch: async (url) => {
    assert.equal(url, GOOGLE_CERTS_URL);
    return Response.json({ "key-one": publicKey.export({ format: "pem", type: "spki" }).toString() });
  } });
  assert.deepEqual(await oauth.verifyIdentity(jwt(), payload.aud, payload.nonce), { subject: "subject", email: "verified@example.test" });
  for (const changes of [
    { iss: "https://attacker.example" }, { aud: "other-client" }, { azp: "other-client" },
    { exp: now - 1 }, { nonce: "wrong" }, { email_verified: false }, { sub: "" }, { email: "" },
  ]) {
    await assert.rejects(oauth.verifyIdentity(jwt(changes), payload.aud, payload.nonce), (error) => code(error, "oauth_identity_invalid"));
  }
  await assert.rejects(oauth.verifyIdentity(jwt({}, otherKey), payload.aud, payload.nonce), (error) => code(error, "oauth_identity_invalid"));
});

test("Desktop OAuth exchanges the callback code using PKCE then verifies identity, and refreshes without URL secrets", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let authorization: URL | undefined;
  let requests = 0;
  const oauth = new GoogleOAuth({
    open: async (url) => {
      authorization = new URL(url);
      await fetch(authorization.searchParams.get("redirect_uri")! + `?state=${authorization.searchParams.get("state")}&code=one-use-code`).catch(() => undefined);
    },
    fetch: async (url, init) => {
      if (url === GOOGLE_CERTS_URL) return Response.json({ key: publicKey.export({ format: "pem", type: "spki" }).toString() });
      assert.equal(url, GOOGLE_TOKEN_URL);
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.doesNotMatch(url, /one-use-code|refresh-secret|client-secret/);
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get("client_secret"), "client-secret");
      assert.equal(body.get("client_id"), "test.apps.googleusercontent.com");
      requests++;
      if (body.get("grant_type") === "refresh_token") {
        assert.equal(body.get("refresh_token"), "refresh-secret");
        return Response.json({ access_token: "refreshed-access", expires_in: 3600, token_type: "Bearer" });
      }
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("code"), "one-use-code");
      assert.equal(body.get("redirect_uri"), authorization!.searchParams.get("redirect_uri"));
      assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), authorization!.searchParams.get("code_challenge"));
      const now = Math.floor(Date.now() / 1000);
      const data = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key" })).toString("base64url") + "." + Buffer.from(JSON.stringify({
        iss: "https://accounts.google.com", aud: body.get("client_id"), iat: now, exp: now + 300,
        sub: "real-verified-subject", email: "person@example.test", email_verified: true, nonce: authorization!.searchParams.get("nonce"),
      })).toString("base64url");
      return Response.json({
        access_token: "issued-access", refresh_token: "refresh-secret", expires_in: 3600, token_type: "Bearer",
        id_token: data + "." + sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url"),
        scope: GOOGLE_SCOPES.join(" "),
      });
    },
  });
  const client = { clientId: "test.apps.googleusercontent.com", clientSecret: "client-secret" };
  const result = await oauth.authorize(client);
  assert.equal(result.identity.subject, "real-verified-subject");
  assert.equal(result.refreshToken, "refresh-secret");
  assert.deepEqual(result.scopes, [...GOOGLE_SCOPES]);
  const refreshed = await oauth.refresh(client, result.refreshToken!);
  assert.equal(refreshed.refreshToken, undefined);
  assert.equal(refreshed.scopes, undefined);
  assert.equal(requests, 2);
});

test("OAuth invalid_grant is actionable and token exchange errors are sanitized without automatic retries", async () => {
  for (const scenario of ["revoked", "server", "network"]) {
    let requests = 0;
    const oauth = new GoogleOAuth({ fetch: async () => {
      requests++;
      if (scenario === "network") throw new Error("refresh_token=PRIVATE-SECRET");
      return Response.json({ error: scenario === "revoked" ? "invalid_grant" : "PRIVATE-SECRET", error_description: "PRIVATE-SECRET" }, { status: scenario === "revoked" ? 400 : 503 });
    } });
    await assert.rejects(oauth.refresh({ clientId: "client", clientSecret: "secret" }, "refresh"), (error) => {
      assert.doesNotMatch(JSON.stringify(publicError(error)), /PRIVATE-SECRET/);
      return scenario !== "revoked" || code(error, "reauth_required");
    });
    assert.equal(requests, 1);
  }
});

test("native vault is lazy, never used on Linux, checks encoded Windows limits and sanitizes failures", async () => {
  let loads = 0;
  let stored: Uint8Array = new Uint8Array();
  const loader = async () => {
    loads++;
    return { AsyncEntry: class {
      async getSecret() { return stored; }
      async setSecret(value: Uint8Array) { stored = value; }
      async deleteCredential() { return true; }
    } };
  };
  const vault = new NativeVault("win32", loader);
  assert.equal(loads, 0);
  await vault.set("reference", "é".repeat(1280));
  assert.equal(stored.byteLength, 2560);
  assert.equal(await vault.get("reference"), "é".repeat(1280));
  await assert.rejects(vault.set("reference", "é".repeat(1281)), (error) => code(error, "credential_size_limit"));
  const before = loads;
  await assert.rejects(new NativeVault("linux", loader).get("reference"), (error) => code(error, "vault_unavailable"));
  assert.equal(loads, before);
  await assert.rejects(new NativeVault("darwin", async () => { throw new Error("SECRET IN NATIVE ERROR"); }).get("reference"), (error) => {
    assert.doesNotMatch(JSON.stringify(publicError(error)), /SECRET/);
    return code(error, "vault_unavailable");
  });
});

test("native vault decodes actual number-array returns as well as typed byte arrays", async () => {
  const secret = "Unicode probe: café";
  for (const value of [Array.from(Buffer.from(secret, "utf8")), new TextEncoder().encode(secret), Buffer.from(secret, "utf8"), undefined]) {
    const vault = new NativeVault("darwin", async () => ({
      AsyncEntry: class {
        async getSecret() { return value; }
        async setSecret() {}
        async deleteCredential() { return true; }
      },
    }));
    assert.equal(await vault.get("reference"), value === undefined ? undefined : secret);
  }
});

test("native vault rejects malformed, oversized and invalidly encoded returns without coercion or disclosure", async () => {
  const invalid: { value: unknown; platform: string; expected: string }[] = [
    ...[[-1], [256], [1.5], [NaN], ["SECRET"], [undefined], new Array(2), null, "SECRET", { data: [65] }]
      .map((value) => ({ value, platform: "darwin", expected: "vault_response_invalid" })),
    { value: [0xff], platform: "darwin", expected: "credential_encoding_invalid" },
    { value: new Uint8Array([0xff]), platform: "darwin", expected: "credential_encoding_invalid" },
    { value: new Array(65_537).fill(65), platform: "darwin", expected: "credential_size_limit" },
    { value: new Array(2561).fill(65), platform: "win32", expected: "credential_size_limit" },
    { value: new Uint8Array(2561).fill(65), platform: "win32", expected: "credential_size_limit" },
  ];
  for (const { value, platform, expected } of invalid) {
    const vault = new NativeVault(platform, async () => ({
      AsyncEntry: class {
        async getSecret() { return value; }
        async setSecret() {}
        async deleteCredential() { return true; }
      },
    }));
    await assert.rejects(vault.get("reference"), (error: unknown) => {
      assert.doesNotMatch(JSON.stringify(publicError(error)), /SECRET/);
      return code(error, expected);
    });
  }
});

test("Linux vault only sends secrets over stdin and never treats lookup/service errors as missing credentials", async () => {
  const invocations: { args: string[]; input?: string }[] = [];
  const vault = new SecretServiceVault(async (args, input) => {
    invocations.push({ args, input });
    return { code: 0, stdout: args[0] === "lookup" ? "private-refresh-token\n" : "", stderrPresent: false };
  });
  await vault.set("refresh-reference", "private-refresh-token");
  assert.equal(await vault.get("refresh-reference"), "private-refresh-token");
  await vault.delete("refresh-reference");
  assert.equal(invocations[0]!.input, "private-refresh-token");
  assert.doesNotMatch(JSON.stringify(invocations.map((call) => call.args)), /private-refresh-token/);
  assert.deepEqual(invocations.map((call) => call.args[0]), ["store", "lookup", "clear"]);
  for (const result of [{ code: 1, stdout: "", stderrPresent: false }, { code: 0, stdout: "token", stderrPresent: true }]) {
    await assert.rejects(new SecretServiceVault(async () => result).get("reference"), (error) => code(error, "vault_unavailable"));
  }
  await assert.rejects(new SecretServiceVault(async () => { throw new Error("secret-tool stderr TOKEN"); }).get("reference"), (error) => {
    assert.doesNotMatch(JSON.stringify(publicError(error)), /TOKEN|stderr/);
    return code(error, "vault_unavailable");
  });
});

test("client references are immutable and only metadata is persisted or returned", async (t) => {
  const f = await fixture(t);
  const first = await f.accounts.add();
  const secondClient = await f.accounts.importClient(f.file);
  assert.notEqual(f.client.id, secondClient.id);
  assert.equal((await f.accounts.get(first.id)).clientId, f.client.id);
  assert.equal(Object.hasOwn(f.client, "clientSecret"), false);
  for (const name of await readdir(f.state.directory)) {
    const contents = await readFile(join(f.state.directory, name), "utf8");
    assert.doesNotMatch(contents, /desktop-client-secret|refresh-one|access-google/);
  }
  await writeFile(f.file, JSON.stringify({ web: { client_id: "web" } }));
  await assert.rejects(f.accounts.importClient(f.file), (error) => code(error, "oauth_client_invalid"));
});

test("duplicate enrollment and subject-mismatched reauth cannot replace another account's credentials", async (t) => {
  let current = grant();
  const f = await fixture(t, { authorize: async () => current, refresh: async () => current });
  const account = await f.accounts.add();
  const initialVault = [...f.vault.entries.entries()];
  current = { ...grant(), refreshToken: "replacement-token" };
  await assert.rejects(f.accounts.add(), (error) => code(error, "account_already_exists"));
  assert.deepEqual([...f.vault.entries.entries()], initialVault);
  current = grant("different-subject", "different-refresh");
  await assert.rejects(f.accounts.reauth(account.id), (error) => code(error, "account_subject_mismatch"));
  assert.deepEqual([...f.vault.entries.entries()], initialVault);
  const second = await f.accounts.add();
  assert.notEqual(second.id, account.id);
  const tokens: string[] = [];
  await f.accounts.withAccess(account.id, account.generation, async (_, token) => { tokens.push(token); });
  await f.accounts.withAccess(second.id, second.generation, async (_, token) => { tokens.push(token); });
  assert.deepEqual(tokens, ["access-google-subject-one", "access-different-subject"]);
});

test("missing or unreadable vault and corrupt metadata fail closed", async (t) => {
  const f = await fixture(t);
  const account = await f.accounts.add();
  f.vault.failRead = true;
  await assert.rejects(f.accounts.withAccess(account.id, undefined, async () => {}), (error) => code(error, "vault_unavailable"));
  f.vault.failRead = false;
  f.vault.entries.clear();
  await assert.rejects(f.accounts.withAccess(account.id, undefined, async () => {}), (error) => code(error, "refresh_token_missing"));
  await f.state.write("auth-registry", { version: 1, accounts: "invalid", clients: [] });
  await assert.rejects(f.accounts.list(), (error) => code(error, "invalid_account_state"));
});

test("initial enrollment without offline refresh credentials cannot activate an account", async (t) => {
  const f = await fixture(t, { authorize: async () => ({ ...grant(), refreshToken: undefined }), refresh: async () => grant() });
  await assert.rejects(f.accounts.add(), (error) => code(error, "refresh_token_missing"));
  assert.deepEqual(await f.accounts.list(), []);
  assert.equal([...f.vault.entries.keys()].some((key) => key.startsWith("refresh-")), false);
});

test("reauth compare-and-swap prevents resurrection after removal during browser ceremony", async (t) => {
  const started = deferred<void>();
  const result = deferred<OAuthGrant>();
  let first = true;
  const f = await fixture(t, {
    authorize: async () => { if (first) { first = false; return grant(); } started.resolve(); return result.promise; },
    refresh: async () => grant(),
  });
  const account = await f.accounts.add();
  const reauth = f.accounts.reauth(account.id);
  await started.promise;
  await f.accounts.remove(account.id);
  result.resolve(grant());
  await assert.rejects(reauth, (error) => code(error, "account_generation_changed"));
  assert.deepEqual(await f.accounts.list(), []);
  assert.equal([...f.vault.entries.keys()].some((key) => key.startsWith("refresh-")), false);
});

test("removal tombstones before credential deletion and cleanup failure stays unavailable", async (t) => {
  const f = await fixture(t);
  const account = await f.accounts.add();
  f.vault.failDelete = true;
  await assert.rejects(f.accounts.remove(account.id), (error) => code(error, "account_removed_cleanup_failed"));
  await assert.rejects(f.accounts.get(account.id), (error) => code(error, "account_not_found"));
  assert.deepEqual(await f.accounts.list(), []);
  f.vault.failDelete = false;
  assert.equal((await f.accounts.remove(account.id)).removed, true);
  assert.equal((await f.accounts.remove(account.id)).removed, true);
});

test("request lifecycle barrier spans dispatch completion so removal cannot race authorization", async (t) => {
  const f = await fixture(t);
  const account = await f.accounts.add();
  const started = deferred<void>();
  const complete = deferred<Response>();
  let dispatches = 0;
  const transport = new AuthenticatedGoogleTransport(f.accounts, { fetch: async (_, init) => {
    dispatches++;
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer access-google-subject-one");
    started.resolve();
    return complete.promise;
  } });
  const request = transport.request(account.id, { api: "gmail", method: "GET", path: "/users/me/messages", readOnly: true });
  await started.promise;
  let removed = false;
  const removal = f.accounts.remove(account.id).then(() => { removed = true; });
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(removed, false);
  complete.resolve(Response.json({ messages: [] }));
  await request;
  await removal;
  await assert.rejects(transport.request(account.id, { api: "gmail", method: "GET", path: "/users/me/messages" }));
  assert.equal(dispatches, 1);
});

test("cross-instance refresh is serialized, rereads rotated credentials and does not replace omitted refresh tokens", async (t) => {
  const refreshInputs: string[] = [];
  const f = await fixture(t);
  const account = await f.accounts.add();
  const provider: OAuthProvider = {
    authorize: async () => grant(),
    refresh: async (_, token) => {
      refreshInputs.push(token);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { accessToken: "new-access", expiresAt: Date.now() + 300_000, ...(refreshInputs.length === 1 ? { refreshToken: "rotated-token" } : {}) };
    },
  };
  const first = new AccountManager(f.state, f.vault, { oauth: provider });
  const second = new AccountManager(f.state, f.vault, { oauth: provider });
  await Promise.all([
    first.withAccess(account.id, account.generation, async () => {}),
    second.withAccess(account.id, account.generation, async () => {}),
  ]);
  assert.deepEqual(refreshInputs, ["refresh-one", "rotated-token"]);
  assert.equal([...f.vault.entries.values()].includes("rotated-token"), true);
  assert.equal([...f.vault.entries.values()].includes("refresh-one"), false);
});

test("credential preparation failures are safe transport failures with zero Google API dispatch", async (t) => {
  const f = await fixture(t);
  const account = await f.accounts.add();
  for (const scenario of ["revoked", "client", "vault", "raw-vault"]) {
    let apiDispatches = 0;
    let tokenRequests = 0;
    const oauth = new GoogleOAuth({ fetch: async (url) => {
      tokenRequests++;
      assert.equal(url, GOOGLE_TOKEN_URL);
      return Response.json({ error: "invalid_grant", error_description: "PRIVATE TOKEN CONTENT" }, { status: 400 });
    } });
    const vault: Vault = {
      get: async (key) => {
        if (scenario === "vault") throw new ConnectorError("vault_unavailable", "Unlock your operating system credential store.", false, { cause: { secret: "PRIVATE VAULT CONTENT" } });
        if (scenario === "raw-vault") throw new Error("PRIVATE RAW VAULT CONTENT");
        if (scenario === "client" && key.startsWith("client-")) return undefined;
        return f.vault.get(key);
      },
      set: (key, value) => f.vault.set(key, value),
      delete: (key) => f.vault.delete(key),
    };
    const manager = new AccountManager(f.state, vault, { oauth });
    const transport = new AuthenticatedGoogleTransport(manager, { fetch: async () => {
      apiDispatches++;
      return Response.json({ id: "must-not-be-created" });
    } });
    await assert.rejects(transport.request(account.id, {
      api: "calendar", method: "POST", path: "/calendars/primary/events",
      body: {}, expectedGeneration: account.generation,
    }), (error) => {
      const expectedCode = scenario === "revoked" ? "reauth_required"
        : scenario === "client" ? "oauth_client_secret_missing"
        : scenario === "vault" ? "vault_unavailable" : "internal_error";
      assert.equal((error as ConnectorError).details?.outcomeUnknown, false);
      assert.equal((error as ConnectorError).details?.accountId, account.id);
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
      if (scenario === "revoked") assert.match((error as Error).message, /accounts reauth/);
      if (scenario === "vault") assert.match((error as Error).message, /Unlock/);
      return code(error, expectedCode);
    });
    assert.equal(apiDispatches, 0);
    assert.equal(tokenRequests, scenario === "revoked" ? 1 : 0);
  }
});

test("the credential preparation guard never wraps action callback failures", async (t) => {
  const f = await fixture(t);
  const account = await f.accounts.add();
  for (const actionError of [
    new ConnectorError("google_mutation_outcome_unknown", "Dispatched mutation outcome is unknown.", false, { outcomeUnknown: true }),
    new Error("Unexpected failure after dispatch"),
  ]) {
    await assert.rejects(f.accounts.withAccess(account.id, account.generation, async () => { throw actionError; }), (error) => error === actionError);
  }
  for (const failure of ["lost", "server"]) {
    let apiDispatches = 0;
    const transport = new AuthenticatedGoogleTransport(f.accounts, { fetch: async () => {
      apiDispatches++;
      if (failure === "lost") throw new Error("Lost connection after dispatch");
      return Response.json({}, { status: 503 });
    } });
    await assert.rejects(transport.request(account.id, { api: "gmail", method: "POST", path: "/users/me/drafts", body: {} }), (error) => {
      assert.equal((error as ConnectorError).details?.outcomeUnknown, true);
      return error instanceof ConnectorError;
    });
    assert.equal(apiDispatches, 1);
  }
});

test("reauth changes generation and stale expectedGeneration never refreshes or dispatches", async (t) => {
  const f = await fixture(t);
  const account = await f.accounts.add();
  const updated = await f.accounts.reauth(account.id);
  assert.notEqual(updated.generation, account.generation);
  let dispatched = false;
  const transport = new AuthenticatedGoogleTransport(f.accounts, { fetch: async () => { dispatched = true; return Response.json({}); } });
  await assert.rejects(transport.request(account.id, { api: "gmail", method: "GET", path: "/users/me/messages", expectedGeneration: account.generation }), (error) => code(error, "account_generation_changed"));
  assert.equal(dispatched, false);
});

test("concurrent reauthorization ceremonies compare-and-swap once without overwriting the winner", async (t) => {
  const ceremonies = [deferred<OAuthGrant>(), deferred<OAuthGrant>()];
  let calls = 0;
  const firstStarted = deferred<void>();
  const started = deferred<void>();
  const f = await fixture(t, {
    authorize: async () => {
      calls++;
      if (calls === 1) return grant();
      if (calls === 2) firstStarted.resolve();
      if (calls === 3) started.resolve();
      return ceremonies[calls - 2]!.promise;
    },
    refresh: async () => grant(),
  });
  const account = await f.accounts.add();
  const first = f.accounts.reauth(account.id);
  await firstStarted.promise;
  const second = f.accounts.reauth(account.id);
  await started.promise;
  ceremonies[0]!.resolve(grant("google-subject-one", "winning-refresh"));
  const winner = await first;
  ceremonies[1]!.resolve(grant("google-subject-one", "losing-refresh"));
  await assert.rejects(second, (error) => code(error, "account_generation_changed"));
  assert.equal((await f.accounts.get(account.id)).generation, winner.generation);
  assert.equal([...f.vault.entries.values()].includes("losing-refresh"), false);
});

test("raw endpoint allowlist rejects send, mailbox mutations, ACL/calendar mutations and encoded traversal", () => {
  for (const path of ["/users/me/messages/send", "/users/me/drafts/a/send", "/users/me/messages/a/modify", "/users/me/messages/batchDelete", "//attacker.example/", "/users/me/messages/%2e%2e", "/users/me/messages/a%2fsend"]) {
    assert.throws(() => validateGoogleRequest({ api: "gmail", method: "POST", path }), (error) => code(error, "google_request_forbidden"));
  }
  for (const path of ["/calendars", "/calendars/primary", "/calendars/primary/acl", "/users/me/calendarList", "/calendars/primary/events/a/move", "/calendars/primary/events/%252e%252e"]) {
    assert.throws(() => validateGoogleRequest({ api: "calendar", method: "POST", path }), (error) => code(error, "google_request_forbidden"));
  }
  assert.equal(validateGoogleRequest({ api: "calendar", method: "POST", path: "/freeBusy" }).read, true);
  assert.equal(validateGoogleRequest({ api: "gmail", method: "POST", path: "/users/me/drafts", readOnly: true }).read, false);
});

test("encoded holiday calendar IDs preserve data characters without accepting path or query injection", async (t) => {
  const f = await fixture(t);
  const account = await f.accounts.add();
  const calendarId = "en.usa#holiday@group.v.calendar.google.com";
  const path = `/calendars/${encodeURIComponent(calendarId)}/events`;
  assert.equal(validateGoogleRequest({ api: "calendar", method: "GET", path }).path, path);
  assert.equal(validateGoogleRequest({
    api: "calendar", method: "GET", path: "/calendars/opaque%3Flabel%23part/events",
  }).path, "/calendars/opaque%3Flabel%23part/events");
  let dispatchedUrl = "";
  const transport = new AuthenticatedGoogleTransport(f.accounts, { fetch: async (url) => {
    dispatchedUrl = url;
    return Response.json({ items: [] });
  } });
  await transport.request(account.id, { api: "calendar", method: "GET", path, query: { maxResults: 10 } });
  const url = new URL(dispatchedUrl);
  assert.equal(url.origin, "https://www.googleapis.com");
  assert.equal(url.pathname, `/calendar/v3${path}`);
  assert.match(url.pathname, /en\.usa%23holiday%40group\.v\.calendar\.google\.com/);
  assert.equal(url.hash, "");
  assert.equal(url.search, "?maxResults=10");
  for (const rejected of [
    `/calendars/${calendarId}/events`,
    "/calendars/opaque?label/events",
    "/calendars/primary%2Fevents/events",
    "/calendars/primary%5Cevents/events",
    "/calendars/%2e%2e/events",
    "/calendars/%252e%252e/events",
    "/calendars/primary%00/events",
    "/calendars/primary/events%23extra",
    "/calendars/primary/events%3Fextra",
  ]) {
    assert.throws(() => validateGoogleRequest({ api: "calendar", method: "GET", path: rejected }), (error) => code(error, "google_request_forbidden"));
  }
});

test("transport retries only opted-in actual reads/freeBusy, never writes; provider failures are sanitized", async (t) => {
  const f = await fixture(t);
  const account = await f.accounts.add();
  let count = 0;
  const waits: number[] = [];
  const transport = new AuthenticatedGoogleTransport(f.accounts, {
    sleep: async (delay) => { waits.push(delay); },
    fetch: async () => {
      count++;
      return count < 3 ? Response.json({ error: { message: "SECRET CONTENT", errors: [{ reason: "rateLimitExceeded" }] } }, { status: 503, headers: { "Retry-After": "1" } }) : Response.json({ ok: true });
    },
  });
  assert.deepEqual(await transport.request(account.id, { api: "calendar", method: "POST", path: "/freeBusy", body: {}, readOnly: true }), { ok: true });
  assert.equal(count, 3);
  assert.deepEqual(waits, [1000, 1000]);
  count = 0;
  await assert.rejects(transport.request(account.id, { api: "gmail", method: "POST", path: "/users/me/drafts", body: {}, readOnly: true }), (error) => {
    assert.doesNotMatch(JSON.stringify(publicError(error)), /SECRET/);
    assert.equal((error as ConnectorError).details?.outcomeUnknown, true);
    return code(error, "google_mutation_outcome_unknown");
  });
  assert.equal(count, 1);
});

test("transport enforces scope, headers, bounded bytes/timeouts, and distinguishes definite mutation failures", async (t) => {
  const f = await fixture(t);
  const account = await f.accounts.add();
  const base = { api: "gmail" as const, method: "POST" as const, path: "/users/me/drafts", body: {} };
  const errorTransport = new AuthenticatedGoogleTransport(f.accounts, { fetch: async () => Response.json({ error: { message: "PRIVATE" } }, { status: 400 }) });
  await assert.rejects(errorTransport.request(account.id, base), (error) => {
    assert.equal((error as ConnectorError).details?.outcomeUnknown, false);
    return code(error, "google_request_failed");
  });
  await assert.rejects(errorTransport.request(account.id, { ...base, headers: { Authorization: "Bearer injected" } }), (error) => code(error, "google_request_forbidden"));
  await assert.rejects(errorTransport.request(account.id, { ...base, query: { access_token: "injected" } }), (error) => code(error, "google_request_forbidden"));
  await assert.rejects(errorTransport.request(account.id, { ...base, maxBytes: 8 * 1024 * 1024 + 1 }), (error) => code(error, "google_request_forbidden"));
  const huge = new AuthenticatedGoogleTransport(f.accounts, { fetch: async () => Response.json({ data: "x".repeat(100) }) });
  await assert.rejects(huge.request(account.id, { ...base, maxBytes: 10 }), (error) => code(error, "response_too_large"));
  const timeout = new AuthenticatedGoogleTransport(f.accounts, { timeoutMs: 20, fetch: async () => new Promise(() => {}) });
  await assert.rejects(timeout.request(account.id, base), (error) => {
    assert.equal((error as ConnectorError).details?.outcomeUnknown, true);
    return code(error, "request_timeout");
  });
  await f.accounts.remove(account.id);
});

test("mutation outcomes explicitly distinguish definitive 4xx from 408, 5xx, lost and invalid success responses", async (t) => {
  const f = await fixture(t);
  const account = await f.accounts.add();
  const request = { api: "gmail" as const, method: "POST" as const, path: "/users/me/drafts", body: {} };
  for (const status of [400, 401, 403, 404, 408, 409, 412, 429, 500, 502, 503, 504]) {
    const transport = new AuthenticatedGoogleTransport(f.accounts, {
      fetch: async () => Response.json({ error: { message: "PRIVATE PROVIDER CONTENT" } }, { status }),
    });
    await assert.rejects(transport.request(account.id, request), (error) => {
      assert.equal((error as ConnectorError).details?.httpStatus, status);
      assert.equal((error as ConnectorError).details?.outcomeUnknown, status === 408 || status >= 500);
      assert.doesNotMatch(JSON.stringify(publicError(error)), /PRIVATE PROVIDER CONTENT/);
      return error instanceof ConnectorError;
    });
  }
  for (const body of ["not-json", ""]) {
    const transport = new AuthenticatedGoogleTransport(f.accounts, { fetch: async () => new Response(body, { status: 200 }) });
    await assert.rejects(transport.request(account.id, request), (error) => {
      assert.equal((error as ConnectorError).details?.httpStatus, 200);
      assert.equal((error as ConnectorError).details?.outcomeUnknown, true);
      return code(error, "invalid_google_response");
    });
  }
  for (const status of [400, 408]) {
    const transport = new AuthenticatedGoogleTransport(f.accounts, { fetch: async () => new Response("oversized error", { status }) });
    await assert.rejects(transport.request(account.id, { ...request, maxBytes: 1 }), (error) => {
      assert.equal((error as ConnectorError).details?.httpStatus, status);
      assert.equal((error as ConnectorError).details?.outcomeUnknown, status === 408);
      return error instanceof ConnectorError;
    });
  }
  const lost = new AuthenticatedGoogleTransport(f.accounts, { fetch: async () => { throw new Error("PRIVATE CONNECTION ERROR"); } });
  await assert.rejects(lost.request(account.id, request), (error) => {
    assert.equal((error as ConnectorError).details?.outcomeUnknown, true);
    return code(error, "google_network_error");
  });
  const deleted = new AuthenticatedGoogleTransport(f.accounts, { fetch: async () => new Response(null, { status: 204 }) });
  assert.equal(await deleted.request(account.id, { api: "calendar", method: "DELETE", path: "/calendars/primary/events/event-one" }), undefined);
});

test("missing feature scopes prohibit dispatch and actual read retries still require explicit opt-in", async (t) => {
  let current = { ...grant(), scopes: ["openid", "email"] };
  const f = await fixture(t, { authorize: async () => current, refresh: async () => current });
  const account = await f.accounts.add();
  let calls = 0;
  const transport = new AuthenticatedGoogleTransport(f.accounts, { fetch: async () => { calls++; return Response.json({}, { status: 503 }); }, sleep: async () => {} });
  await assert.rejects(transport.request(account.id, { api: "gmail", method: "GET", path: "/users/me/messages", readOnly: true }), (error) => {
    assert.equal((error as ConnectorError).details?.outcomeUnknown, false);
    return code(error, "missing_scopes");
  });
  assert.equal(calls, 0);
  current = grant();
  await f.accounts.reauth(account.id);
  await assert.rejects(transport.request(account.id, { api: "gmail", method: "GET", path: "/users/me/messages" }));
  assert.equal(calls, 1);
});

test("validated method is snapshotted before waiting on refresh and cannot become a send", async (t) => {
  const f = await fixture(t);
  const account = await f.accounts.add();
  const refreshing = deferred<void>();
  const refreshed = deferred<OAuthGrant>();
  const manager = new AccountManager(f.state, f.vault, {
    oauth: { authorize: async () => grant(), refresh: async () => { refreshing.resolve(); return refreshed.promise; } },
  });
  let method: string | undefined;
  const transport = new AuthenticatedGoogleTransport(manager, { fetch: async (_, init) => { method = init.method; return Response.json({}); } });
  const input = { api: "gmail" as const, method: "GET" as "GET" | "POST", path: "/users/me/messages/send" };
  const result = transport.request(account.id, input);
  await refreshing.promise;
  input.method = "POST";
  refreshed.resolve(grant());
  await result;
  assert.equal(method, "GET");
});
