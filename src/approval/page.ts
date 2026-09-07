export const stylesheet = `
:root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
body { max-width: 64rem; margin: 2rem auto; padding: 0 1rem; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid #888; padding: 1rem; }
button { font: inherit; padding: .6rem 1rem; margin: .5rem .5rem .5rem 0; cursor: pointer; }
button:focus-visible { outline: 3px solid #3989ff; outline-offset: 3px; }
button:disabled { cursor: not-allowed; }
#status { min-height: 3rem; }
`;

export const browserScript = `
"use strict";
const action = document.getElementById("action");
const cancel = document.getElementById("cancel");
const status = document.getElementById("status");
const enrolling = document.body.dataset.mode === "enroll";
const base = window.location.pathname;
let controller;
let cancelled = false;
function decode(value) {
  const text = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(text + "=".repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0));
}
function encode(value) {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
}
async function post(suffix, body) {
  const response = await fetch(base + "/" + suffix, {
    method: "POST", credentials: "omit", redirect: "error",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "Request rejected. Check the operation status.");
  return result;
}
action.addEventListener("click", async () => {
  action.disabled = true;
  let submitted = false;
  try {
    if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) {
      throw new Error("WebAuthn is unavailable. Use a supported browser and a user-verifying authenticator. No approval was submitted.");
    }
    const options = await post("options", {});
    if (cancelled) return;
    options.challenge = decode(options.challenge);
    if (enrolling) {
      options.user.id = decode(options.user.id);
      options.excludeCredentials = (options.excludeCredentials || []).map(item => ({ ...item, id: decode(item.id) }));
    } else {
      options.allowCredentials = options.allowCredentials.map(item => ({ ...item, id: decode(item.id) }));
    }
    controller = new AbortController();
    status.textContent = enrolling ? "Use your authenticator to complete trusted initial setup." : "Verify with your enrolled authenticator to approve this exact operation.";
    const credential = enrolling
      ? await navigator.credentials.create({ publicKey: options, signal: controller.signal })
      : await navigator.credentials.get({ publicKey: options, signal: controller.signal });
    if (cancelled) return;
    if (!credential) throw new Error("No credential returned. No approval was submitted.");
    const response = { clientDataJSON: encode(credential.response.clientDataJSON) };
    if (enrolling) {
      response.attestationObject = encode(credential.response.attestationObject);
      if (credential.response.getTransports) response.transports = credential.response.getTransports();
    } else {
      response.authenticatorData = encode(credential.response.authenticatorData);
      response.signature = encode(credential.response.signature);
      if (credential.response.userHandle) response.userHandle = encode(credential.response.userHandle);
    }
    const payload = {
      id: credential.id, rawId: encode(credential.rawId), type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(), response
    };
    submitted = true;
    const result = await post("verify", { response: payload });
    status.textContent = result.message;
    cancel.disabled = true;
  } catch (error) {
    if (cancelled) return;
    status.textContent = submitted
      ? "Approval response unavailable or rejected. Check the connector operation status before any retry."
      : (error.name === "NotAllowedError" || error.name === "AbortError"
        ? "Authenticator request denied or timed out. No approval was submitted."
        : error.message);
    if (!submitted) action.disabled = false;
  }
});
cancel.addEventListener("click", async () => {
  cancel.disabled = true;
  try {
    const result = await post("cancel", {});
    cancelled = true;
    controller?.abort();
    action.disabled = true;
    status.textContent = result.message;
  } catch (error) {
    status.textContent = error.message;
    cancel.disabled = false;
  }
});
`;

function escape(text: string): string {
  return text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export function renderPage(mode: "review" | "enroll", manifest?: string): string {
  const enroll = mode === "enroll";
  const title = enroll ? "Enroll an approval authenticator" : "Review one Google Calendar operation";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="/assets/approval.css">
<script src="/assets/approval.js" defer></script></head><body data-mode="${mode}"><main>
<h1>${title}</h1>
${enroll ? `<p>This is trusted initial setup, not an operation approval. Continue only if you deliberately ran
<code>google-connector approvals enroll</code> outside an untrusted agent workflow.</p>
<p>The first credential becomes the only permitted approval key. This ceremony does not prove a human
initiated the terminal command, and normal service mode cannot replace this credential.</p>`
    : `<p>No Calendar mutation has been sent by this approval request. Review the complete server-owned
manifest below, including account, action, attendees, recurrence scope and notification policy.</p>
<p>Google controls notification delivery; <code>sendUpdates: none</code> does not guarantee that
every Google-generated message is suppressed. Series and exception limitations are part of the manifest.</p>
<h2 id="manifest-heading">Exact operation manifest</h2><pre aria-labelledby="manifest-heading">${escape(manifest!)}</pre>`}
<p>A supported platform or roaming authenticator must verify you with a PIN, biometric, or equivalent.
Touch-only keys without user verification cannot authorize an operation.</p>
<button id="action" type="button">${enroll ? "Enroll authenticator" : "Approve with authenticator"}</button>
<button id="cancel" type="button">Cancel</button>
<p id="status" role="status" aria-live="polite"></p></main></body></html>`;
}
