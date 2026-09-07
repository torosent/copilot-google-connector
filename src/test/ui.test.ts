import test from "node:test";
import assert from "node:assert/strict";
import { Script, createContext } from "node:vm";
import { browserScript, renderPage } from "../approval/page.js";

test("the packaged browser script parses and the review page escapes hostile content", () => {
  assert.doesNotThrow(() => new Script(browserScript));
  const html = renderPage("review", '{"summary":"</pre><script>alert(1)</script>\\n\u202efake"}');
  assert.match(html, /&lt;\/pre&gt;&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert|[\u202e]/);
  for (const id of ["action", "cancel", "status"]) assert.match(html, new RegExp(`id="${id}"`));
});

for (const mode of ["review", "enroll"] as const) {
  test(`browser ${mode} flow translates WebAuthn binary inputs and outputs (fake browser)`, async () => {
    const clicks = new Map<string, () => Promise<void>>();
    const elements = new Map(["action", "cancel", "status"].map((id) => [id, {
      disabled: false,
      textContent: "",
      addEventListener: (_event: string, callback: () => Promise<void>) => { clicks.set(id, callback); },
    }]));
    const bytes = Uint8Array.from([1, 2, 3]).buffer;
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    let sawBinaryChallenge = false;
    const credential = {
      id: "AQID", rawId: bytes, type: "public-key",
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: bytes, authenticatorData: bytes, signature: bytes,
        userHandle: bytes, attestationObject: bytes, getTransports: () => ["internal"],
      },
    };
    const getCredential = async (options: { publicKey: { challenge: Uint8Array; user?: { id: Uint8Array }; allowCredentials?: { id: Uint8Array }[] } }) => {
      sawBinaryChallenge = ArrayBuffer.isView(options.publicKey.challenge) && options.publicKey.challenge[0] === 1;
      if (mode === "enroll") assert.equal(options.publicKey.user?.id[1], 2);
      else assert.equal(options.publicKey.allowCredentials?.[0]?.id[2], 3);
      return credential;
    };
    const context = createContext({
      document: { body: { dataset: { mode } }, getElementById: (id: string) => elements.get(id) },
      window: { location: { pathname: `/${mode}/fixture` }, isSecureContext: true, PublicKeyCredential: {} },
      navigator: { credentials: { create: getCredential, get: getCredential } },
      Uint8Array, AbortController, atob, btoa,
      fetch: async (path: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        posts.push({ path, body });
        return {
          ok: true,
          json: async () => path.endsWith("/options")
            ? { challenge: "AQID", user: { id: "AQID" }, allowCredentials: [{ id: "AQID" }], excludeCredentials: [] }
            : { message: "Fixture submitted." },
        };
      },
    });
    new Script(browserScript).runInContext(context);
    await clicks.get("action")!();
    assert.equal(sawBinaryChallenge, true);
    assert.equal(posts.length, 2);
    const payload = posts[1]!.body.response as Record<string, unknown>;
    assert.equal(payload.rawId, "AQID");
    const response = payload.response as Record<string, unknown>;
    assert.equal(response.clientDataJSON, "AQID");
    assert.equal(mode === "enroll" ? response.attestationObject : response.signature, "AQID");
    assert.equal(elements.get("status")?.textContent, "Fixture submitted.");
  });
}
