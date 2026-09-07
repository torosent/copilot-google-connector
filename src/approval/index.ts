import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { z } from "zod";
import { canonical, digest } from "../core/canonical.js";
import { ConnectorError } from "../core/errors.js";
import type { StateStore } from "../core/state.js";
import type { ApprovalGateway, ApprovalRequest } from "../core/types.js";
import {
  ALGORITHMS, APPROVAL_ENROLLMENT_KEY, RP_ID, authenticationSchema, registrationSchema,
  readEnrollment, validateEnrollment, type EnrollmentRecord,
} from "./credential.js";
import { browserScript, renderPage, stylesheet } from "./page.js";

export { APPROVAL_ENROLLMENT_KEY } from "./credential.js";
export type { EnrollmentRecord } from "./credential.js";

const PROPOSAL_TTL = 5 * 60_000;
const CHALLENGE_TTL = 2 * 60_000;
const MAX_BODY = 64 * 1024;
const MAX_MANIFEST = 1024 * 1024;
const MAX_OPERATIONS = 512;
const emptyBody = z.object({}).strict();
const verifyBody = z.object({ response: authenticationSchema }).strict();
const enrollBody = z.object({ response: registrationSchema }).strict();

/** Dependency injection is for in-process, offline tests, never CLI/MCP configuration. */
export interface ApprovalDependencies {
  now?: () => number;
  verifyAuthentication?: typeof verifyAuthenticationResponse;
  verifyRegistration?: typeof verifyRegistrationResponse;
  openBrowser?: (url: string) => Promise<void>;
}

export interface EnrollmentResult {
  status: "enrolled";
  credentialGeneration: string;
}

type Status = "pending" | "verifying" | "claimed" | "finished" | "cancelled" | "expired";
interface Ceremony {
  token: string;
  expiresAt: number;
  status: Status;
  challenge?: { value: string; expiresAt: number };
  timer?: ReturnType<typeof setTimeout>;
}
interface Proposal extends Ceremony {
  operationId: string;
  binding: string;
  enrollmentIdentity: string;
  manifest?: string;
  approve: ApprovalRequest["approve"];
  cancel: ApprovalRequest["cancel"];
}
interface Enrollment extends Ceremony {
  userId: string;
  resolve: (result: EnrollmentResult) => void;
  reject: (error: Error) => void;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function unavailable(): never {
  throw new ConnectorError("approval_unavailable", "Approval requires an existing enrolled authenticator. Deliberately run 'google-connector approvals enroll' outside the agent workflow first.");
}

function enrollmentIdentity(record: EnrollmentRecord): string {
  return digest({
    generation: record.generation, rpID: record.rpID, userId: record.userId,
    id: record.credential.id, publicKey: record.credential.publicKey,
  });
}

async function openBrowser(url: string): Promise<void> {
  const [command, args] = process.platform === "darwin" ? ["open", [url]] as const
    : process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const
    : ["xdg-open", [url]] as const;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: "ignore", shell: false, windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      reject(new ConnectorError("browser_unavailable", "The browser could not be opened for enrollment."));
    }, 10_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new ConnectorError("browser_unavailable", "The browser could not be opened for enrollment."));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new ConnectorError("browser_unavailable", "The browser could not be opened for enrollment."));
    });
  });
}

export class WebAuthnApprovalGateway implements ApprovalGateway {
  private mode: "idle" | "service" | "enrollment" | "closed" = "idle";
  private server?: Server;
  private started?: Promise<string>;
  private origin = "";
  private readonly proposals = new Map<string, Proposal>();
  private readonly requests = new Map<string, { identity: string; result: Promise<string> }>();
  private enrollment?: Enrollment;
  private closing?: Promise<void>;
  private readonly now: () => number;
  private readonly verifyAuthentication: typeof verifyAuthenticationResponse;
  private readonly verifyRegistration: typeof verifyRegistrationResponse;
  private readonly browser: (url: string) => Promise<void>;

  constructor(private readonly state: StateStore, dependencies: ApprovalDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
    this.verifyAuthentication = dependencies.verifyAuthentication ?? verifyAuthenticationResponse;
    this.verifyRegistration = dependencies.verifyRegistration ?? verifyRegistrationResponse;
    this.browser = dependencies.openBrowser ?? openBrowser;
  }

  async request(input: ApprovalRequest): Promise<string> {
    if (this.mode === "enrollment" || this.mode === "closed") {
      throw new ConnectorError("approval_mode", "This gateway is not accepting approval requests.");
    }
    this.mode = "service";
    const request = z.object({
      operationId: z.string().min(1).max(256),
      accountId: z.string().min(1).max(256),
      accountGeneration: z.string().min(1).max(256),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      preview: z.record(z.string(), z.unknown()),
      expiresAt: z.number().int().positive(),
    }).parse(input);
    // Capture every binding and callback before awaiting I/O. Later caller
    // mutations cannot change either the displayed manifest or its assertion.
    const captured = canonical({ version: 1, ...request });
    if (Buffer.byteLength(captured) > MAX_MANIFEST) {
      throw new ConnectorError("approval_manifest_too_large", "The complete approval manifest exceeds the local review limit.");
    }
    const identity = digest(JSON.parse(captured));
    const existing = this.requests.get(request.operationId);
    if (existing) {
      if (existing.identity !== identity) throw new ConnectorError("approval_conflict", "This operation ID already refers to a different immutable approval request.");
      return existing.result;
    }
    if (this.requests.size >= MAX_OPERATIONS) {
      throw new ConnectorError("approval_capacity", "This connector session reached its approval limit. Finish pending work and restart it.");
    }
    const expiresAt = Math.min(request.expiresAt, this.now() + PROPOSAL_TTL);
    if (expiresAt <= this.now()) throw new ConnectorError("approval_expired", "The approval proposal has expired.");
    const snapshot = JSON.parse(captured) as Record<string, unknown>;
    snapshot.expiresAt = expiresAt;
    const { approve, cancel } = input;
    const result = this.createProposal(request.operationId, snapshot, expiresAt, approve, cancel);
    this.requests.set(request.operationId, { identity, result });
    try {
      return await result;
    } catch (error) {
      this.requests.delete(request.operationId);
      throw error;
    }
  }

  private async createProposal(
    operationId: string, snapshot: Record<string, unknown>, expiresAt: number,
    approve: ApprovalRequest["approve"], cancel: ApprovalRequest["cancel"],
  ): Promise<string> {
    const record = await readEnrollment(this.state);
    if (!record) unavailable();
    const origin = await this.start();
    if (this.mode !== "service" || expiresAt <= this.now()) {
      throw new ConnectorError("approval_expired", "The approval gateway closed or the proposal expired.");
    }
    const proposal: Proposal = {
      token: randomBytes(24).toString("base64url"), operationId, expiresAt, status: "pending",
      binding: digest(snapshot), enrollmentIdentity: enrollmentIdentity(record),
      manifest: JSON.stringify(snapshot, null, 2), approve, cancel,
    };
    proposal.timer = setTimeout(() => this.expire(proposal), expiresAt - this.now());
    proposal.timer.unref();
    this.proposals.set(proposal.token, proposal);
    return `${origin}/review/${proposal.token}`;
  }

  async enroll(): Promise<EnrollmentResult> {
    if (this.mode !== "idle") throw new ConnectorError("approval_mode", "Enrollment is permitted only as a separate, deliberately invoked initial-setup command.");
    this.mode = "enrollment";
    try {
      await this.state.withLock(APPROVAL_ENROLLMENT_KEY, async () => this.assertAbsent());
      const origin = await this.start();
      if (this.mode !== "enrollment") throw new ConnectorError("approval_closed", "Enrollment was closed.");
      const completion = new Promise<EnrollmentResult>((resolve, reject) => {
        const enrollment: Enrollment = {
          token: randomBytes(24).toString("base64url"), userId: randomBytes(32).toString("base64url"),
          expiresAt: this.now() + PROPOSAL_TTL, status: "pending", resolve, reject,
        };
        enrollment.timer = setTimeout(() => this.expire(enrollment), PROPOSAL_TTL);
        this.enrollment = enrollment;
      });
      // Attach a rejection handler before opening the browser; a concurrent close
      // or timeout must not produce an unhandled rejection during browser startup.
      void completion.catch(() => {});
      await this.browser(`${origin}/enroll/${this.enrollment!.token}`);
      return await completion;
    } finally {
      await this.close();
    }
  }

  private async assertAbsent(): Promise<void> {
    if (await readEnrollment(this.state) !== undefined) {
      throw new ConnectorError("approval_already_enrolled", "An approval credential is already enrolled. Normal setup never replaces or resets it.");
    }
  }

  private start(): Promise<string> {
    if (this.started) return this.started;
    this.started = new Promise<string>((resolve, reject) => {
      if (this.mode === "closed") { reject(new ConnectorError("approval_closed", "The approval gateway is closed.")); return; }
      const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
        this.headers(response);
        void this.handle(request, response).catch((error: unknown) => {
          if (response.destroyed || response.writableEnded) return;
          if (error instanceof HttpError) {
            this.json(response, error.status, { code: error.code, message: error.message });
          } else {
            this.json(response, 400, { code: "approval_rejected", message: "Approval was not accepted. Check enrollment and operation status; do not automatically repeat a write." });
          }
        });
      });
      this.server = server;
      server.maxConnections = 32;
      server.maxRequestsPerSocket = 64;
      server.requestTimeout = 10_000;
      server.headersTimeout = 5_000;
      server.keepAliveTimeout = 1000;
      server.once("error", () => reject(new ConnectorError("approval_listener_failed", "The private approval listener could not start.")));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") { reject(new ConnectorError("approval_listener_failed", "The private approval listener could not start.")); return; }
        this.origin = `http://${RP_ID}:${address.port}`;
        resolve(this.origin);
      });
    });
    return this.started;
  }

  private headers(response: ServerResponse): void {
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Permissions-Policy", `publickey-credentials-get=(self), publickey-credentials-create=${this.mode === "enrollment" ? "(self)" : "()"}`);
    response.setHeader("Cache-Control", "no-store");
  }

  private checkRequest(request: IncomingMessage): void {
    const counts = new Map<string, number>();
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index]!.toLowerCase();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const origin = request.headers.origin;
    if (counts.get("host") !== 1 || (counts.get("origin") ?? 0) > 1
      || request.headers.host !== this.origin.slice("http://".length)
      || (origin !== undefined && origin !== this.origin)
      || (request.method === "POST" && origin !== this.origin)) {
      throw new HttpError(403, "request_origin", "The exact local Host and Origin are required.");
    }
    const site = request.headers["sec-fetch-site"];
    if ((site !== undefined && site !== "same-origin" && site !== "none")
      || request.headers["sec-fetch-dest"] === "iframe") {
      throw new HttpError(403, "cross_origin", "Cross-origin and framed requests are not permitted.");
    }
    if (this.mode === "closed") throw new HttpError(410, "approval_closed", "The approval gateway is closed.");
  }

  private async body(request: IncomingMessage): Promise<unknown> {
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")
      || request.headers["content-encoding"] !== undefined) {
      throw new HttpError(415, "content_type", "Send an uncompressed application/json body.");
    }
    const length = request.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) {
      request.resume();
      throw new HttpError(413, "body_limit", "The approval request body is too large.");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > MAX_BODY) throw new HttpError(413, "body_limit", "The approval request body is too large.");
      chunks.push(Buffer.from(chunk));
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new HttpError(400, "invalid_json", "The approval request is not valid UTF-8 JSON.");
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.checkRequest(request);
    if (request.method !== "GET" && request.method !== "POST") throw new HttpError(405, "method", "This HTTP method is not supported.");
    const path = request.url ?? "";
    if (request.method === "GET" && path === "/assets/approval.js") {
      this.text(response, "text/javascript; charset=utf-8", browserScript); return;
    }
    if (request.method === "GET" && path === "/assets/approval.css") {
      this.text(response, "text/css; charset=utf-8", stylesheet); return;
    }
    const route = /^\/(review|enroll)\/([A-Za-z0-9_-]{32})(?:\/(options|verify|cancel))?$/.exec(path);
    if (!route) throw new HttpError(404, "not_found", "No such local approval page.");
    const [, kind, token, action] = route;
    const ceremony = kind === "review" && this.mode === "service" ? this.proposals.get(token!)
      : kind === "enroll" && this.mode === "enrollment" && this.enrollment?.token === token ? this.enrollment : undefined;
    if (!ceremony) throw new HttpError(404, "not_found", "No such local approval page.");
    if (request.method === "GET") {
      if (action) throw new HttpError(405, "method", "This action requires a same-origin POST.");
      this.assertPending(ceremony);
      this.text(response, "text/html; charset=utf-8", renderPage(kind as "review" | "enroll", "manifest" in ceremony ? ceremony.manifest : undefined));
      return;
    }
    if (!action) throw new HttpError(405, "method", "This page supports GET only.");
    const body = await this.body(request);
    if (action === "cancel") {
      emptyBody.parse(body);
      await this.cancel(ceremony);
      try {
        this.json(response, 200, { status: "cancelled", message: "Cancelled before approval was claimed. No Calendar write was authorized by this request." });
      } finally {
        if (ceremony === this.enrollment) ceremony.reject(new ConnectorError("approval_cancelled", "Authenticator enrollment was cancelled."));
      }
    } else if (action === "options") {
      emptyBody.parse(body);
      this.assertPending(ceremony);
      const options = "binding" in ceremony ? await this.authenticationOptions(ceremony) : await this.registrationOptions(ceremony);
      this.json(response, 200, options);
    } else if ("binding" in ceremony) {
      const parsed = verifyBody.parse(body);
      await this.authenticate(ceremony, parsed.response);
      this.json(response, 200, { status: "approval_submitted", message: "Approval verified and claimed. Check the connector operation status for the final outcome." });
    } else {
      const parsed = enrollBody.parse(body);
      const result = await this.register(ceremony, parsed.response);
      try {
        this.json(response, 200, { ...result, message: "Authenticator enrolled. Close this page; normal service mode cannot replace this credential." });
      } finally {
        // A dropped browser connection cannot leave completed enrollment waiting.
        ceremony.resolve(result);
      }
    }
  }

  private assertPending(ceremony: Ceremony, verifying = false): void {
    if (ceremony.expiresAt <= this.now()) this.expire(ceremony);
    if (this.mode === "closed" || (ceremony.status !== "pending" && !(verifying && ceremony.status === "verifying"))) {
      throw new HttpError(ceremony.status === "expired" ? 410 : 409, "approval_not_pending", "This request expired, was cancelled, or was already claimed. Check the connector operation status.");
    }
  }

  private async currentEnrollment(proposal: Proposal): Promise<EnrollmentRecord> {
    const record = await readEnrollment(this.state);
    if (!record || enrollmentIdentity(record) !== proposal.enrollmentIdentity) {
      throw new HttpError(409, "enrollment_changed", "The enrolled credential changed. This proposal cannot be approved.");
    }
    return record;
  }

  private challenge(ceremony: Ceremony, binding: string): string {
    const value = Buffer.concat([randomBytes(32), Buffer.from(binding, "hex")]).toString("base64url");
    ceremony.challenge = { value, expiresAt: Math.min(this.now() + CHALLENGE_TTL, ceremony.expiresAt) };
    return value;
  }

  private async authenticationOptions(proposal: Proposal) {
    const record = await this.currentEnrollment(proposal);
    this.assertPending(proposal);
    const challenge = this.challenge(proposal, proposal.binding);
    return generateAuthenticationOptions({
      rpID: RP_ID, challenge: new Uint8Array(Buffer.from(challenge, "base64url")),
      timeout: Math.max(1, proposal.challenge!.expiresAt - this.now()),
      userVerification: "required",
      allowCredentials: [{ id: record.credential.id, transports: record.credential.transports }],
    });
  }

  private async registrationOptions(enrollment: Enrollment) {
    await this.state.withLock(APPROVAL_ENROLLMENT_KEY, async () => this.assertAbsent());
    this.assertPending(enrollment);
    const challenge = this.challenge(enrollment, digest({ version: 1, userId: enrollment.userId, token: enrollment.token }));
    return generateRegistrationOptions({
      rpName: "Local Google connector approvals", rpID: RP_ID,
      userName: "Local connector approval", userDisplayName: "Local connector approval",
      userID: new Uint8Array(Buffer.from(enrollment.userId, "base64url")),
      challenge: new Uint8Array(Buffer.from(challenge, "base64url")),
      timeout: Math.max(1, enrollment.challenge!.expiresAt - this.now()), attestationType: "none",
      authenticatorSelection: { userVerification: "required", residentKey: "discouraged" },
      supportedAlgorithmIDs: [...ALGORITHMS],
    });
  }

  private takeChallenge(ceremony: Ceremony): { value: string; expiresAt: number } {
    this.assertPending(ceremony);
    const challenge = ceremony.challenge;
    ceremony.challenge = undefined;
    if (!challenge || challenge.expiresAt <= this.now()) {
      throw new HttpError(410, "challenge_expired", "Obtain a fresh authenticator challenge while the proposal remains valid.");
    }
    ceremony.status = "verifying";
    return challenge;
  }

  private clientData(encoded: string, challenge: string, type: "webauthn.get" | "webauthn.create"): void {
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64url")));
    const parsed = z.object({
      type: z.literal(type), origin: z.literal(this.origin), challenge: z.literal(challenge),
      crossOrigin: z.literal(false).optional(), topOrigin: z.never().optional(),
    }).passthrough().safeParse(data);
    if (!parsed.success) throw new HttpError(400, "client_data", "The signed ceremony data does not match this local request.");
  }

  private async authenticate(proposal: Proposal, response: z.infer<typeof authenticationSchema>): Promise<void> {
    const challenge = this.takeChallenge(proposal);
    try {
      this.clientData(response.response.clientDataJSON, challenge.value, "webauthn.get");
      const signed = Buffer.from(response.response.authenticatorData, "base64url");
      if (signed.length < 37 || (signed[32]! & 0x05) !== 0x05
        || !signed.subarray(0, 32).equals(createHash("sha256").update(RP_ID).digest())) {
        throw new HttpError(400, "authenticator_flags", "Signed user presence, user verification and the correct relying party are required.");
      }
      await this.state.withLock(APPROVAL_ENROLLMENT_KEY, async () => {
        this.assertPending(proposal, true);
        const record = await this.currentEnrollment(proposal);
        if (response.id !== record.credential.id
          || (response.response.userHandle !== undefined && response.response.userHandle !== record.userId)) {
          throw new HttpError(400, "credential", "Only the previously enrolled credential may approve.");
        }
        const verified = await this.verifyAuthentication({
          response, expectedChallenge: challenge.value, expectedOrigin: this.origin, expectedRPID: RP_ID,
          expectedType: "webauthn.get", requireUserVerification: true,
          // Omit advancedFIDOConfig: the WebAuthn defaults enforce BOTH UP and UV.
          credential: { ...record.credential, publicKey: new Uint8Array(Buffer.from(record.credential.publicKey, "base64url")) },
        });
        const info = verified.authenticationInfo;
        if (!verified.verified || !info.userVerified || info.credentialID !== record.credential.id
          || info.origin !== this.origin || info.rpID !== RP_ID || !Number.isInteger(info.newCounter)
          || info.newCounter !== signed.readUInt32BE(33)
          || ((info.newCounter > 0 || record.credential.counter > 0) && info.newCounter <= record.credential.counter)) {
          throw new HttpError(400, "assertion_invalid", "The enrolled authenticator assertion could not be verified.");
        }
        this.assertPending(proposal, true);
        if (challenge.expiresAt <= this.now()) throw new HttpError(410, "challenge_expired", "The authenticator challenge expired before it was claimed.");
        await this.currentEnrollment(proposal);
        const updated = validateEnrollment({
          ...record, credential: { ...record.credential, counter: info.newCounter },
          credentialDeviceType: info.credentialDeviceType, credentialBackedUp: info.credentialBackedUp,
        });
        await this.state.write(APPROVAL_ENROLLMENT_KEY, updated);
        this.assertPending(proposal, true);
        if (challenge.expiresAt <= this.now()) throw new HttpError(410, "challenge_expired", "The authenticator challenge expired before it was claimed.");
        // One synchronous transition under the enrollment lock wins over replay,
        // cancellation and shutdown. The parent independently claims durable dispatch.
        proposal.status = "claimed";
        proposal.manifest = undefined;
        clearTimeout(proposal.timer);
      });
    } catch (error) {
      if (proposal.status === "verifying") proposal.status = "pending";
      throw error;
    }
    try {
      await proposal.approve();
    } catch {
      throw new HttpError(409, "approval_claimed", "Approval was claimed, but its final outcome must be checked through the connector. Do not automatically repeat the write.");
    } finally {
      proposal.status = "finished";
    }
  }

  private async register(enrollment: Enrollment, response: z.infer<typeof registrationSchema>): Promise<EnrollmentResult> {
    const challenge = this.takeChallenge(enrollment);
    try {
      this.clientData(response.response.clientDataJSON, challenge.value, "webauthn.create");
      const verified = await this.verifyRegistration({
        response, expectedChallenge: challenge.value, expectedOrigin: this.origin, expectedRPID: RP_ID,
        expectedType: "webauthn.create", requireUserPresence: true, requireUserVerification: true,
        supportedAlgorithmIDs: [...ALGORITHMS],
      });
      if (!verified.verified || !verified.registrationInfo.userVerified
        || verified.registrationInfo.origin !== this.origin || verified.registrationInfo.rpID !== RP_ID
        || verified.registrationInfo.credential.id !== response.id) {
        throw new HttpError(400, "registration_invalid", "The authenticator registration could not be verified.");
      }
      const info = verified.registrationInfo;
      const record = validateEnrollment({
        version: 1, rpID: RP_ID, generation: randomUUID(), userId: enrollment.userId, createdAt: this.now(),
        credential: { ...info.credential, publicKey: Buffer.from(info.credential.publicKey).toString("base64url") },
        credentialDeviceType: info.credentialDeviceType, credentialBackedUp: info.credentialBackedUp,
      });
      await this.state.withLock(APPROVAL_ENROLLMENT_KEY, async () => {
        await this.assertAbsent();
        this.assertPending(enrollment, true);
        if (challenge.expiresAt <= this.now()) throw new HttpError(410, "challenge_expired", "The registration challenge expired.");
        enrollment.status = "claimed";
        clearTimeout(enrollment.timer);
        await this.state.write(APPROVAL_ENROLLMENT_KEY, record);
        enrollment.status = "finished";
      });
      return { status: "enrolled", credentialGeneration: record.generation };
    } catch (error) {
      if (enrollment.status === "verifying") enrollment.status = "pending";
      if (enrollment.status === "claimed") {
        enrollment.reject(new ConnectorError("approval_enrollment_failed", "Enrollment persistence failed. Inspect local state before attempting trusted setup again."));
      }
      throw error;
    }
  }

  private stop(ceremony: Ceremony, status: "cancelled" | "expired"): void {
    ceremony.status = status;
    ceremony.challenge = undefined;
    clearTimeout(ceremony.timer);
    if ("manifest" in ceremony) ceremony.manifest = undefined;
  }

  private async cancel(ceremony: Ceremony): Promise<void> {
    this.assertPending(ceremony, true);
    this.stop(ceremony, "cancelled");
    if ("cancel" in ceremony) await (ceremony as Proposal).cancel();
  }

  private expire(ceremony: Ceremony): void {
    if (ceremony.status !== "pending" && ceremony.status !== "verifying") return;
    this.stop(ceremony, "expired");
    if ("cancel" in ceremony) void Promise.resolve().then(() => (ceremony as Proposal).cancel()).catch(() => {});
    else (ceremony as Enrollment).reject(new ConnectorError("approval_expired", "Authenticator enrollment expired without completing."));
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.statusCode = status;
    this.text(response, "application/json; charset=utf-8", JSON.stringify(value));
  }

  private text(response: ServerResponse, contentType: string, text: string): void {
    response.setHeader("Content-Type", contentType);
    response.setHeader("Content-Length", Buffer.byteLength(text));
    response.end(text);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.mode = "closed";
    const cancellations: Promise<unknown>[] = [];
    for (const proposal of this.proposals.values()) {
      if (proposal.status === "pending" || proposal.status === "verifying") {
        this.stop(proposal, "cancelled");
        cancellations.push(Promise.resolve().then(() => proposal.cancel()));
      }
    }
    if (this.enrollment && (this.enrollment.status === "pending" || this.enrollment.status === "verifying")) {
      this.stop(this.enrollment, "cancelled");
      this.enrollment.reject(new ConnectorError("approval_closed", "Authenticator enrollment was closed without completing."));
    }
    this.closing = (async () => {
      if (this.started) await this.started.catch(() => {});
      if (this.server) {
        const server = this.server;
        await new Promise<void>((resolve) => {
          // Allow a just-completed enrollment response to flush, but never wait
          // indefinitely for an abandoned HTTP client or an in-flight dispatch.
          const deadline = setTimeout(() => server.closeAllConnections(), 250);
          deadline.unref();
          server.close(() => { clearTimeout(deadline); resolve(); });
        });
      }
      await Promise.allSettled(cancellations);
      this.proposals.clear();
      this.requests.clear();
    })();
    return this.closing;
  }
}
