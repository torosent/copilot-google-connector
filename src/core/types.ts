import type { z } from "zod";

export interface Account {
  id: string;
  email: string;
  subject: string;
  clientId: string;
  generation: string;
  scopes: string[];
}

export interface Accounts {
  list(): Promise<Account[]>;
  get(accountId: string): Promise<Account>;
}

export interface GoogleRequest {
  api: "gmail" | "calendar";
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  readOnly?: boolean;
  expectedGeneration?: string;
  maxBytes?: number;
}

export interface GoogleTransport {
  request<T>(accountId: string, request: GoogleRequest): Promise<T>;
}

export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodObject;
  readOnly: boolean;
  handler(input: Record<string, unknown>): Promise<unknown>;
}

export interface MutationPlan {
  kind: string;
  accountId: string;
  accountGeneration: string;
  requiresApproval: boolean;
  preview: Record<string, unknown>;
  execute(): Promise<unknown>;
}

export interface OperationSubmitter {
  submit(
    accountId: string,
    requestId: string,
    intent: unknown,
    prepare: () => Promise<MutationPlan>,
  ): Promise<unknown>;
}

export interface PrivateProvenance {
  matches(accountId: string, calendarId: string, eventId: string, etag: string): Promise<boolean>;
  record(accountId: string, calendarId: string, eventId: string, etag: string): Promise<void>;
  forget(accountId: string, calendarId: string, eventId: string): Promise<void>;
}

export interface ServiceDependencies {
  accounts: Accounts;
  transport: GoogleTransport;
  operations: OperationSubmitter;
}

export interface ApprovalRequest {
  operationId: string;
  accountId: string;
  accountGeneration: string;
  digest: string;
  preview: Record<string, unknown>;
  expiresAt: number;
  approve(): Promise<unknown>;
  cancel(): Promise<unknown>;
}

export interface ApprovalGateway {
  request(input: ApprovalRequest): Promise<string>;
  close(): Promise<void>;
}
