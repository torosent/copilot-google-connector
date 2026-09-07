import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../core/state.js";
import { OperationEngine, FileProvenance } from "../core/operations.js";
import { ConnectorError, publicError } from "../core/errors.js";
import { digest } from "../core/canonical.js";
import type { Account, Accounts, ApprovalGateway, ApprovalRequest, MutationPlan } from "../core/types.js";

const account: Account = { id: "account-one", email: "one@example.test", subject: "subject-one", clientId: "client-one", generation: "generation-one", scopes: [] };

class FakeApproval implements ApprovalGateway {
  requests: ApprovalRequest[] = [];
  async request(input: ApprovalRequest) { this.requests.push(input); return `http://localhost:1234/review/${input.operationId}`; }
  async close() {}
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "google-connector-core-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let current = account;
  const accounts: Accounts = {
    list: async () => [current],
    get: async (id) => { if (id !== current.id) throw new ConnectorError("account_not_found", "Account not found."); return current; },
  };
  const state = new StateStore(directory);
  const approval = new FakeApproval();
  let now = 100000;
  const engine = new OperationEngine(state, accounts, approval, () => now);
  return { directory, state, approval, engine, accounts, advance: (ms: number) => { now += ms; }, changeAccount: () => { current = { ...current, generation: "changed" }; } };
}

function plan(execute: () => Promise<unknown>, requiresApproval = false): MutationPlan {
  return { kind: "calendar.create", accountId: account.id, accountGeneration: account.generation, requiresApproval, preview: { attendees: ["other@example.test"], sendUpdates: "all" }, execute };
}

test("canonical intent is stable across object key order and rejects non-JSON", () => {
  assert.equal(digest({ a: 1, b: [2, 3] }), digest({ b: [2, 3], a: 1 }));
  assert.throws(() => digest({ invalid: Infinity }), /JSON/);
});

test("idempotent writes reserve before preparation, persist dispatch first, and never persist content", async (t) => {
  const f = await fixture(t);
  let preparations = 0;
  let executions = 0;
  const prepare = async () => {
    preparations++;
    return plan(async () => {
      executions++;
      const stored = await f.state.read<{ status: string }>(`operation-${digest({ accountId: account.id, requestId: "request-one" })}`);
      assert.equal(stored?.status, "dispatching");
      return { eventId: "event-one", description: "PRIVATE EVENT BODY", access_token: "NEVER PERSIST" };
    });
  };
  const first = await f.engine.submit(account.id, "request-one", { summary: "hello" }, prepare) as { status: string };
  const second = await f.engine.submit(account.id, "request-one", { summary: "hello" }, prepare) as { status: string };
  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "succeeded");
  assert.equal(preparations, 1);
  assert.equal(executions, 1);
  const receipts = (await readdir(f.directory)).filter((name) => name.endsWith(".json"));
  for (const name of receipts) {
    const text = await readFile(join(f.directory, name), "utf8");
    assert.doesNotMatch(text, /PRIVATE EVENT BODY|NEVER PERSIST/);
  }
  await assert.rejects(f.engine.submit(account.id, "request-one", { summary: "different" }, prepare), /different arguments/);
});

test("concurrent server instances execute a request ID once", async (t) => {
  const f = await fixture(t);
  const second = new OperationEngine(f.state, f.accounts, new FakeApproval(), () => 100000);
  let writes = 0;
  const prepare = async () => plan(async () => { writes++; return { eventId: "event" }; });
  await Promise.all([
    f.engine.submit(account.id, "request-concurrent", {}, prepare),
    second.submit(account.id, "request-concurrent", {}, prepare),
  ]);
  assert.equal(writes, 1);
});

test("approval is pending until gateway callback and is single use", async (t) => {
  const f = await fixture(t);
  let writes = 0;
  const pending = await f.engine.submit(account.id, "request-approval", {}, async () => plan(async () => { writes++; return {}; }, true)) as { status: string };
  assert.equal(pending.status, "pending_approval");
  assert.equal(writes, 0);
  const request = f.approval.requests[0]!;
  assert.equal(request.accountId, account.id);
  assert.equal(request.accountGeneration, account.generation);
  assert.equal(request.digest.length, 64);
  await request.approve();
  await assert.rejects(request.approve(), /no longer available/);
  assert.equal(writes, 1);
});

test("cancellation, expiry, and generation change reject pending approvals", async (t) => {
  for (const reason of ["cancel", "expire", "account"] as const) {
    const f = await fixture(t);
    let writes = 0;
    await f.engine.submit(account.id, `request-${reason}`, {}, async () => plan(async () => { writes++; }, true));
    const request = f.approval.requests[0]!;
    if (reason === "cancel") await request.cancel();
    if (reason === "expire") f.advance(300001);
    if (reason === "account") f.changeAccount();
    await assert.rejects(request.approve());
    assert.equal(writes, 0);
  }
});

test("ambiguous outcomes remain unknown and cannot be automatically resubmitted", async (t) => {
  const f = await fixture(t);
  let writes = 0;
  const prepare = async () => plan(async () => {
    writes++;
    throw new ConnectorError("network_failed", "Response lost.", false, { outcomeUnknown: true });
  });
  const first = await f.engine.submit(account.id, "request-unknown", {}, prepare) as { status: string };
  const second = await f.engine.submit(account.id, "request-unknown", {}, prepare) as { status: string };
  assert.equal(first.status, "outcome_unknown");
  assert.equal(second.status, "outcome_unknown");
  assert.equal(writes, 1);
});

test("explicit rejection stays failed without being mistaken for unknown success", async (t) => {
  const f = await fixture(t);
  const result = await f.engine.submit(account.id, "request-rejected", {}, async () => plan(async () => {
    throw new ConnectorError("precondition_failed", "The event changed.", false, { httpStatus: 412, outcomeUnknown: false });
  })) as { status: string };
  assert.equal(result.status, "failed");
});

for (const requiresApproval of [false, true]) {
test(`lost outcome persistence reports unknown for ${requiresApproval ? "approved" : "private"} writes`, async (t) => {
  const f = await fixture(t);
  class FailingStore extends StateStore {
    failed = false;
    override async write(key: string, value: unknown): Promise<void> {
      if (!this.failed && value && typeof value === "object" && "status" in value && value.status === "succeeded") {
        this.failed = true;
        throw new ConnectorError("state_write_failed", "Injected persistence failure.");
      }
      await super.write(key, value);
    }
  }
  const engine = new OperationEngine(new FailingStore(f.directory), f.accounts, f.approval);
  let writes = 0;
  const prepare = async () => plan(async () => { writes++; return {}; }, requiresApproval);
  const submitted = await engine.submit(account.id, "request-persist", {}, prepare) as { status: string; operationId: string };
  const first = requiresApproval ? await f.approval.requests[0]!.approve() as { status: string } : submitted;
  assert.equal(first.status, "outcome_unknown");
  assert.equal((await engine.status(account.id, submitted.operationId) as { status: string }).status, "outcome_unknown");
  await engine.submit(account.id, "request-persist", {}, prepare);
  assert.equal(writes, 1);
});
}

test("approved completion becomes unknown after persistent storage recovers without killing the owner", async (t) => {
  const f = await fixture(t);
  class UnavailableStore extends StateStore {
    unavailable = false;
    override async write(key: string, value: unknown): Promise<void> {
      if (this.unavailable) throw new ConnectorError("state_write_failed", "Injected unavailable storage.");
      await super.write(key, value);
    }
  }
  const state = new UnavailableStore(f.directory);
  const engine = new OperationEngine(state, f.accounts, f.approval);
  let writes = 0;
  const prepare = async () => plan(async () => { writes++; state.unavailable = true; return {}; }, true);
  const pending = await engine.submit(account.id, "request-outage", {}, prepare) as { operationId: string };
  await assert.rejects(f.approval.requests[0]!.approve(), (error: unknown) => error instanceof ConnectorError && error.details?.outcomeUnknown === true);
  state.unavailable = false;
  assert.equal((await engine.status(account.id, pending.operationId) as { status: string }).status, "outcome_unknown");
  assert.equal((await engine.submit(account.id, "request-outage", {}, prepare) as { status: string }).status, "outcome_unknown");
  assert.equal(writes, 1);
});

test("cancellation cannot promise rollback once dispatch wins", async (t) => {
  const f = await fixture(t);
  let started!: () => void;
  let finish!: () => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  const completion = new Promise<void>((resolve) => { finish = resolve; });
  const operationId = digest({ accountId: account.id, requestId: "request-inflight" });
  const result = f.engine.submit(account.id, "request-inflight", {}, async () => plan(async () => {
    started();
    await completion;
    return {};
  }));
  await dispatched;
  await assert.rejects(f.engine.cancel(account.id, operationId), /already dispatched/);
  await f.engine.close();
  assert.equal((await f.engine.status(account.id, operationId) as { status: string }).status, "dispatching");
  finish();
  assert.equal((await result as { status: string }).status, "succeeded");
});

test("account IDs bind operation visibility and private provenance", async (t) => {
  const f = await fixture(t);
  const secondAccount = { ...account, id: "account-two" };
  const accounts: Accounts = { list: async () => [account, secondAccount], get: async (id) => id === account.id ? account : secondAccount };
  const engine = new OperationEngine(f.state, accounts, f.approval);
  const output = await engine.submit(account.id, "request-account", {}, async () => plan(async () => ({}), true)) as { operationId: string };
  await assert.rejects(engine.status(secondAccount.id, output.operationId), /another account/);
  await assert.rejects(engine.cancel(secondAccount.id, output.operationId), /another account/);
  const provenance = new FileProvenance(f.state);
  await provenance.record(account.id, "primary", "event", "etag");
  assert.equal(await provenance.matches(account.id, "primary", "event", "etag"), true);
  assert.equal(await provenance.matches(secondAccount.id, "primary", "event", "etag"), false);
  assert.equal(await provenance.matches(account.id, "primary", "event", "changed-etag"), false);
});

test("state corruption and nested provider failures never become empty success or leak tokens", async (t) => {
  const f = await fixture(t);
  await f.state.write("corrupt-receipt", { value: 1 });
  await assert.rejects(f.state.read("../escape"), /state/);
  const error = new Error("token SECRET", { cause: { access_token: "SECRET" } });
  assert.doesNotMatch(JSON.stringify(publicError(error)), /SECRET/);
  assert.doesNotMatch(JSON.stringify(publicError(new ConnectorError("safe", "Safe.", false, { cause: { refresh_token: "SECRET" }, access_token: "SECRET" }))), /SECRET/);
  assert.equal(await f.state.read("absent"), undefined);
});
