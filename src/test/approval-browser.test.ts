import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { browserScript } from "../approval/page.js";

function fakePage(mode: "review" | "enroll", available = true) {
  const events = new Map<string, () => Promise<void>>();
  const elements = Object.fromEntries(["action", "cancel", "status"].map((name) => [name, {
    disabled: false, textContent: "",
    addEventListener: (_type: string, action: () => Promise<void>) => { events.set(name, action); },
  }]));
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let credentialCalls = 0;
  const credential = {
    id: "AQID", rawId: Uint8Array.from([1, 2, 3]).buffer, type: "public-key",
    getClientExtensionResults: () => ({}),
    response: {
      clientDataJSON: Uint8Array.from([251, 255, 0]).buffer,
      authenticatorData: Uint8Array.from([255, 1]).buffer,
      signature: Uint8Array.from([0, 255, 2]).buffer,
      userHandle: null,
      attestationObject: Uint8Array.from([255, 255, 255]).buffer,
      getTransports: () => ["internal"],
    },
  };
  const ceremony = async ({ publicKey }: { publicKey: Record<string, unknown> }) => {
    credentialCalls++;
    assert.deepEqual(Array.from(publicKey.challenge as Uint8Array), [251, 255, 0]);
    if (mode === "review") {
      assert.deepEqual(Array.from((publicKey.allowCredentials as { id: Uint8Array }[])[0]!.id), [1, 2, 3]);
      assert.equal(publicKey.userVerification, "required");
    } else {
      assert.deepEqual(Array.from((publicKey.user as { id: Uint8Array }).id), [1, 2, 3]);
    }
    return credential;
  };
  const context = {
    document: { getElementById: (id: string) => elements[id], body: { dataset: { mode } } },
    window: { isSecureContext: available, PublicKeyCredential: available ? class {} : undefined, location: { pathname: "/test" } },
    navigator: { credentials: { get: ceremony, create: ceremony } },
    atob, btoa, AbortController,
    fetch: async (path: string, request: { method: string; body: string; headers: Record<string, string>; redirect: string; credentials: string }) => {
      assert.equal(request.method, "POST");
      assert.equal(request.headers["Content-Type"], "application/json");
      assert.equal(request.redirect, "error");
      assert.equal(request.credentials, "omit");
      calls.push({ path, body: JSON.parse(request.body) as Record<string, unknown> });
      return { ok: true, json: async () => path.endsWith("/options")
        ? {
          challenge: "-_8A", allowCredentials: [{ id: "AQID", type: "public-key" }],
          user: { id: "AQID" }, excludeCredentials: [], userVerification: "required",
        }
        : { message: "Local fake response" } };
    },
  };
  new Script(browserScript).runInNewContext(context);
  return { events, elements, calls, credentialCalls: () => credentialCalls };
}

test("LOCAL FAKE page serializes native authentication buffers without frontend dependencies", async () => {
  const page = fakePage("review");
  assert.equal(page.credentialCalls(), 0);
  assert.equal(page.calls.length, 0);
  await page.events.get("action")!();
  assert.equal(page.credentialCalls(), 1);
  assert.deepEqual(page.calls.map((call) => call.path), ["/test/options", "/test/verify"]);
  assert.deepEqual(page.calls[1]!.body, {
    response: {
      id: "AQID", rawId: "AQID", type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: "-_8A", authenticatorData: "_wE", signature: "AP8C" },
    },
  });
  assert.equal(page.elements.status!.textContent, "Local fake response");
});

test("LOCAL FAKE page serializes native registration buffers and transports", async () => {
  const page = fakePage("enroll");
  await page.events.get("action")!();
  assert.equal(page.credentialCalls(), 1);
  assert.deepEqual(page.calls[1]!.body, {
    response: {
      id: "AQID", rawId: "AQID", type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: "-_8A", attestationObject: "____", transports: ["internal"] },
    },
  });
});

test("unsupported browser submits neither options nor an approval", async () => {
  const page = fakePage("review", false);
  await page.events.get("action")!();
  assert.equal(page.credentialCalls(), 0);
  assert.equal(page.calls.length, 0);
  assert.match(page.elements.status!.textContent, /No approval was submitted/);
  assert.equal(page.elements.action!.disabled, false);
});
