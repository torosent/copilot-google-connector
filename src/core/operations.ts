import { randomUUID } from "node:crypto";
import { z } from "zod";
import { digest } from "./canonical.js";
import { ConnectorError, publicError } from "./errors.js";
import { StateStore } from "./state.js";
import type { Accounts, ApprovalGateway, MutationPlan, OperationSubmitter, PrivateProvenance, ToolSpec } from "./types.js";

const receiptSchema = z.object({
  version: z.literal(1),
  operationId: z.string(),
  accountId: z.string(),
  requestId: z.string(),
  intentHash: z.string(),
  owner: z.string(),
  pid: z.number().int().positive(),
  createdAt: z.number(),
  expiresAt: z.number(),
  status: z.enum(["reserved", "pending_approval", "dispatching", "succeeded", "failed", "outcome_unknown", "cancelled", "expired"]),
  kind: z.string().optional(),
  reviewUrl: z.string().optional(),
  error: z.record(z.string(), z.unknown()).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
});
type Receipt = z.infer<typeof receiptSchema>;

function isPreDispatch(status: Receipt["status"]): boolean {
  return status === "reserved" || status === "pending_approval";
}

function safeReceiptResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return {};
  const input = result as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const name of ["id", "draftId", "messageId", "threadId", "eventId", "calendarId", "accountId", "status", "etag", "htmlLink"]) {
    const value = input[name];
    if (typeof value === "string" && value.length <= 2048) output[name] = value;
  }
  return output;
}

function ownerDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

export class OperationEngine implements OperationSubmitter {
  private readonly owner = randomUUID();
  private readonly pending = new Map<string, MutationPlan>();
  private readonly completed = new Map<string, unknown>();
  private readonly unrecordedOutcomes = new Set<string>();
  private closed = false;

  constructor(
    private readonly state: StateStore,
    private readonly accounts: Accounts,
    private readonly approval: ApprovalGateway,
    private readonly now: () => number = Date.now,
  ) {}

  private key(operationId: string): string {
    if (!/^[a-f0-9]{64}$/.test(operationId)) throw new ConnectorError("invalid_operation", "Invalid operation identifier.");
    return `operation-${operationId}`;
  }

  private async load(operationId: string): Promise<Receipt> {
    const value = await this.state.read<unknown>(this.key(operationId));
    if (value === undefined) throw new ConnectorError("operation_not_found", "The operation does not exist.");
    const parsed = receiptSchema.safeParse(value);
    if (!parsed.success) throw new ConnectorError("invalid_operation_state", "Operation receipt is corrupt. It must not be retried automatically.");
    return parsed.data;
  }

  private output(receipt: Receipt): Record<string, unknown> {
    return {
      operationId: receipt.operationId,
      accountId: receipt.accountId,
      requestId: receipt.requestId,
      status: receipt.status,
      expiresAt: new Date(receipt.expiresAt).toISOString(),
      ...(receipt.status === "pending_approval" ? { reviewUrl: receipt.reviewUrl } : {}),
      ...(receipt.error ? { error: receipt.error } : {}),
      ...(receipt.status === "succeeded" ? { result: this.completed.get(receipt.operationId) ?? receipt.result, receiptOnly: !this.completed.has(receipt.operationId) } : {}),
    };
  }

  async submit(accountId: string, requestId: string, intent: unknown, prepare: () => Promise<MutationPlan>): Promise<unknown> {
    if (this.closed) throw new ConnectorError("server_closed", "The connector is shutting down.");
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) throw new ConnectorError("invalid_request_id", "requestId must be 8-128 ASCII letters, numbers, '.', '_', ':' or '-'.");
    const account = await this.accounts.get(accountId);
    const operationId = digest({ accountId, requestId });
    const intentHash = digest({ accountId, intent });
    const operationExists = await this.state.withLock(this.key(operationId), async () => {
      const previous = await this.state.read<unknown>(this.key(operationId));
      if (previous !== undefined) {
        const existing = await this.load(operationId);
        if (existing.intentHash !== intentHash) throw new ConnectorError("request_id_conflict", "This requestId was already used with different arguments. Do not reuse it for a different operation.");
        return true;
      }
      const receipt: Receipt = {
        version: 1, operationId, accountId, requestId, intentHash, owner: this.owner,
        pid: process.pid, createdAt: this.now(), expiresAt: this.now() + 300_000, status: "reserved",
      };
      await this.state.write(this.key(operationId), receipt);
      return false;
    });
    if (operationExists) return this.status(accountId, operationId);
    try {
      const plan = await prepare();
      if (this.closed) throw new ConnectorError("server_closed", "The connector shut down before preparation completed.");
      if (plan.accountId !== accountId || plan.accountGeneration !== account.generation) {
        throw new ConnectorError("account_changed", "Account state changed while preparing this operation. Use a new request after reviewing it.");
      }
      this.pending.set(operationId, plan);
      if (plan.requiresApproval) {
        const receipt = await this.load(operationId);
        const reviewUrl = await this.approval.request({
          operationId, accountId, accountGeneration: plan.accountGeneration,
          digest: digest({ intentHash, kind: plan.kind, accountId, accountGeneration: plan.accountGeneration, preview: plan.preview }),
          preview: { ...plan.preview, accountId, email: account.email, action: plan.kind },
          expiresAt: receipt.expiresAt,
          approve: () => this.dispatch(accountId, operationId),
          cancel: () => this.cancel(accountId, operationId),
        });
        return await this.state.withLock(this.key(operationId), async () => {
          const current = await this.load(operationId);
          if (current.status !== "reserved") return this.output(current);
          current.status = "pending_approval";
          current.kind = plan.kind;
          current.reviewUrl = reviewUrl;
          await this.state.write(this.key(operationId), current);
          return this.output(current);
        });
      }
      return await this.dispatch(accountId, operationId);
    } catch (error) {
      this.pending.delete(operationId);
      return this.state.withLock(this.key(operationId), async () => {
        const receipt = await this.load(operationId);
        if (isPreDispatch(receipt.status)) {
          receipt.status = "failed";
          receipt.error = publicError(error);
          await this.state.write(this.key(operationId), receipt);
        } else if (receipt.status === "dispatching") {
          throw error;
        }
        return this.output(receipt);
      });
    }
  }

  private async dispatch(accountId: string, operationId: string): Promise<unknown> {
    const plan = this.pending.get(operationId);
    if (!plan || this.closed) throw new ConnectorError("operation_unavailable", "This prepared operation is no longer available.");
    const receipt = await this.state.withLock(this.key(operationId), async () => {
      const current = await this.load(operationId);
      if (current.accountId !== accountId || current.owner !== this.owner) throw new ConnectorError("operation_account_mismatch", "Operation is not owned by this account and server.");
      if (!isPreDispatch(current.status)) throw new ConnectorError("operation_consumed", "This operation can no longer be executed.");
      if (this.now() >= current.expiresAt) {
        current.status = "expired";
        await this.state.write(this.key(operationId), current);
        throw new ConnectorError("approval_expired", "The operation expired. Review a new request.");
      }
      const account = await this.accounts.get(accountId);
      if (account.generation !== plan.accountGeneration) throw new ConnectorError("account_changed", "The account changed after this operation was prepared.");
      current.status = "dispatching";
      current.kind = plan.kind;
      await this.state.write(this.key(operationId), current);
      return current;
    });
    try {
      const result = await plan.execute();
      this.completed.set(operationId, result);
      if (this.completed.size > 64) {
        const oldest = this.completed.keys().next().value;
        if (oldest !== undefined) this.completed.delete(oldest);
      }
      receipt.result = safeReceiptResult(result);
      receipt.status = "succeeded";
    } catch (error) {
      const knownFailure = error instanceof ConnectorError && error.details?.outcomeUnknown === false;
      receipt.status = knownFailure ? "failed" : "outcome_unknown";
      receipt.error = publicError(error);
    } finally {
      this.pending.delete(operationId);
    }
    try {
      await this.state.withLock(this.key(operationId), () => this.state.write(this.key(operationId), receipt));
    } catch {
      const failure = new ConnectorError("receipt_persist_failed", "The dispatch started but its outcome could not be persisted. Inspect Google before any new write.", false, { outcomeUnknown: true, operationId });
      this.unrecordedOutcomes.add(operationId);
      this.completed.delete(operationId);
      receipt.status = "outcome_unknown";
      delete receipt.result;
      receipt.error = publicError(failure);
      try {
        // Retry only the local receipt write, never the Google mutation.
        await this.state.withLock(this.key(operationId), () => this.state.write(this.key(operationId), receipt));
        this.unrecordedOutcomes.delete(operationId);
      } catch {
        throw failure;
      }
    }
    return this.output(receipt);
  }

  async status(accountId: string, operationId: string): Promise<unknown> {
    await this.accounts.get(accountId);
    return this.state.withLock(this.key(operationId), async () => {
      const receipt = await this.load(operationId);
      if (receipt.accountId !== accountId) throw new ConnectorError("operation_account_mismatch", "This operation belongs to another account.");
      if (isPreDispatch(receipt.status) && (this.now() >= receipt.expiresAt || ownerDead(receipt.pid))) {
        receipt.status = "expired";
        this.pending.delete(operationId);
        await this.state.write(this.key(operationId), receipt);
      } else if (receipt.status === "dispatching" && (ownerDead(receipt.pid) || this.unrecordedOutcomes.has(operationId))) {
        receipt.status = "outcome_unknown";
        receipt.error = { code: "unrecorded_dispatch_outcome", message: "The dispatch is no longer running but its final outcome was not recorded. Inspect Google before attempting a new write.", outcomeUnknown: true };
        await this.state.write(this.key(operationId), receipt);
      }
      if (receipt.status !== "dispatching") this.unrecordedOutcomes.delete(operationId);
      return this.output(receipt);
    });
  }

  async cancel(accountId: string, operationId: string): Promise<unknown> {
    await this.accounts.get(accountId);
    return this.state.withLock(this.key(operationId), async () => {
      const receipt = await this.load(operationId);
      if (receipt.accountId !== accountId) throw new ConnectorError("operation_account_mismatch", "This operation belongs to another account.");
      if (isPreDispatch(receipt.status)) {
        receipt.status = "cancelled";
        this.pending.delete(operationId);
        await this.state.write(this.key(operationId), receipt);
      } else if (receipt.status === "dispatching") {
        throw new ConnectorError("too_late_to_cancel", "The request has already dispatched. Cancellation cannot guarantee rollback.");
      }
      return this.output(receipt);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      for (const [operationId, plan] of this.pending) {
        try {
          await this.cancel(plan.accountId, operationId);
        } catch (error) {
          if (!(error instanceof ConnectorError) || !["too_late_to_cancel", "account_not_found", "account_removed"].includes(error.code)) throw error;
        }
      }
    } finally {
      this.pending.clear();
      await this.approval.close();
    }
  }
}

export class FileProvenance implements PrivateProvenance {
  constructor(private readonly state: StateStore) {}
  private key(accountId: string, calendarId: string, eventId: string): string {
    return `private-${digest({ accountId, calendarId, eventId })}`;
  }
  async matches(accountId: string, calendarId: string, eventId: string, etag: string): Promise<boolean> {
    const value = await this.state.read<unknown>(this.key(accountId, calendarId, eventId));
    if (value === undefined) return false;
    const record = z.object({ etag: z.string() }).safeParse(value);
    if (!record.success) throw new ConnectorError("invalid_provenance", "Private-event provenance is corrupt; do not bypass approval.");
    return record.data.etag === etag;
  }
  async record(accountId: string, calendarId: string, eventId: string, etag: string): Promise<void> {
    await this.state.write(this.key(accountId, calendarId, eventId), { etag });
  }
  async forget(accountId: string, calendarId: string, eventId: string): Promise<void> {
    await this.state.remove(this.key(accountId, calendarId, eventId));
  }
}

export function operationTools(engine: OperationEngine): ToolSpec[] {
  const schema = z.object({ accountId: z.string().min(1), operationId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
  return [
    {
      name: "operation_status",
      description: "Read the status of an explicitly selected account's write. An unknown outcome must never be blindly retried.",
      schema,
      readOnly: true,
      async handler(input): Promise<unknown> {
        const args = schema.parse(input);
        return engine.status(args.accountId, args.operationId);
      },
    },
    {
      name: "operation_cancel",
      description: "Cancel a pending operation before dispatch. Does not undo an already-dispatched Google action.",
      schema,
      readOnly: false,
      async handler(input): Promise<unknown> {
        const args = schema.parse(input);
        return engine.cancel(args.accountId, args.operationId);
      },
    },
  ];
}
