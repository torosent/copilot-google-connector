import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { ConnectorError, publicError } from "../core/errors.js";
import { StateStore } from "../core/state.js";
import type { Account, Accounts } from "../core/types.js";
import { GoogleOAuth, type DesktopClient, type OAuthGrant, type OAuthProvider, type Tokens } from "./oauth.js";
import { createVault, type Vault } from "./vault.js";

const REGISTRY_KEY = "auth-registry";
const idSchema = z.uuid();
const scopeSchema = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/);
const clientIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/);
const clientSchema = z.object({ id: idSchema, clientId: clientIdSchema }).strict();
const accountSchema = z.object({
  id: idSchema, subject: z.string().min(1).max(255).regex(/^[\x21-\x7e]+$/),
  email: z.email().max(320), clientId: idSchema, generation: idSchema,
  scopes: z.array(scopeSchema).max(100),
  status: z.enum(["active", "removed"]),
  credentialGenerations: z.array(idSchema).max(1000),
}).strict();
const registrySchema = z.object({
  version: z.literal(1),
  defaultClient: idSchema.optional(),
  clients: z.array(clientSchema).max(1000),
  accounts: z.array(accountSchema).max(10_000),
}).strict();
type Registry = z.infer<typeof registrySchema>;
type AccountRecord = z.infer<typeof accountSchema>;
export type ClientMetadata = z.infer<typeof clientSchema>;

const tokensSchema = z.object({
  accessToken: z.string().min(1).max(32_768).regex(/^[\x21-\x7e]+$/),
  expiresAt: z.number().finite().positive(),
  refreshToken: z.string().min(1).max(2048).regex(/^[\x21-\x7e]+$/).optional(),
  scopes: z.array(scopeSchema).max(100).optional(),
});
const grantSchema = tokensSchema.extend({
  scopes: z.array(scopeSchema).max(100),
  identity: z.object({ subject: accountSchema.shape.subject, email: accountSchema.shape.email }),
});

function asAccount(record: AccountRecord): Account {
  return { id: record.id, email: record.email, subject: record.subject, clientId: record.clientId, generation: record.generation, scopes: [...record.scopes] };
}
function refreshKey(accountId: string, generation: string): string { return `refresh-${accountId}-${generation}`; }
function clientKey(reference: string): string { return `client-${reference}`; }
function fingerprint(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function unavailable(accountId: string): ConnectorError {
  return new ConnectorError("account_not_found", "This account is not enrolled or has been removed. Choose an account from accounts list.", false, { accountId, outcomeUnknown: false });
}

export class AccountManager implements Accounts {
  private readonly oauth: OAuthProvider;
  private readonly now: () => number;
  private readonly vault: Vault;
  private readonly accessTokens = new Map<string, { accessToken: string; expiresAt: number; generation: string; refreshFingerprint: string }>();

  constructor(
    private readonly state: StateStore,
    vault?: Vault,
    options: { oauth?: OAuthProvider; now?: () => number } = {},
  ) {
    this.vault = vault ?? createVault();
    this.oauth = options.oauth ?? new GoogleOAuth();
    this.now = options.now ?? Date.now;
  }

  private async registry(): Promise<Registry> {
    const raw = await this.state.read<unknown>(REGISTRY_KEY);
    if (raw === undefined) return { version: 1, clients: [], accounts: [] };
    const parsed = registrySchema.safeParse(raw);
    if (!parsed.success) throw new ConnectorError("invalid_account_state", "Account metadata is corrupt. Do not delete or reset it automatically.");
    const registry = parsed.data;
    const clients = new Set(registry.clients.map((client) => client.id));
    const activeSubjects = registry.accounts.filter((account) => account.status === "active").map((account) => account.subject);
    if (clients.size !== registry.clients.length || new Set(registry.accounts.map((account) => account.id)).size !== registry.accounts.length
      || new Set(activeSubjects).size !== activeSubjects.length
      || (registry.defaultClient && !clients.has(registry.defaultClient))
      || registry.accounts.some((account) => !clients.has(account.clientId) || (account.status === "active" && !account.credentialGenerations.includes(account.generation))
        || new Set(account.credentialGenerations).size !== account.credentialGenerations.length)) {
      throw new ConnectorError("invalid_account_state", "Account metadata contains invalid identity or credential references. Do not reset it automatically.");
    }
    return registry;
  }

  private async persist(registry: Registry): Promise<void> {
    if (!registrySchema.safeParse(registry).success) {
      throw new ConnectorError("account_state_capacity", "The account registry reached its supported metadata limits. No credentials were activated.");
    }
    await this.state.write(REGISTRY_KEY, registry);
  }

  async list(): Promise<Account[]> {
    return (await this.registry()).accounts.filter((record) => record.status === "active").map(asAccount);
  }

  async get(accountId: string): Promise<Account> {
    if (!idSchema.safeParse(accountId).success) throw unavailable(accountId);
    const record = (await this.registry()).accounts.find((entry) => entry.id === accountId && entry.status === "active");
    if (!record) throw unavailable(accountId);
    return asAccount(record);
  }

  private async client(reference: string, registry?: Registry): Promise<DesktopClient> {
    const metadata = (registry ?? await this.registry()).clients.find((client) => client.id === reference);
    if (!metadata) throw new ConnectorError("oauth_client_missing", "The account's immutable OAuth client reference is missing.");
    const secret = await this.vault.get(clientKey(reference));
    if (!secret) throw new ConnectorError("oauth_client_secret_missing", "The imported client secret is missing from secure storage. Restore the operating system credential store.");
    return { clientId: metadata.clientId, clientSecret: secret };
  }

  async importClient(path: string): Promise<ClientMetadata> {
    let file;
    let raw: unknown;
    try {
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error();
      const data = await file.readFile("utf8");
      if (Buffer.byteLength(data) > 64 * 1024) throw new Error();
      raw = JSON.parse(data);
    } catch {
      throw new ConnectorError("oauth_client_file_invalid", "Cannot read a bounded Desktop OAuth client JSON file. Use a regular, non-symlink file exported from Google Cloud.");
    } finally {
      await file?.close();
    }
    const schema = z.object({
      installed: z.object({
        client_id: clientIdSchema,
        client_secret: z.string().min(1).max(2048).regex(/^[\x21-\x7e]+$/),
        auth_uri: z.enum(["https://accounts.google.com/o/oauth2/auth", "https://accounts.google.com/o/oauth2/v2/auth"]).optional(),
        token_uri: z.literal("https://oauth2.googleapis.com/token").optional(),
        redirect_uris: z.array(z.string().max(1024).refine((value) => {
          try {
            const url = new URL(value);
            return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password && !url.hash && !url.search;
          } catch { return false; }
        })).min(1).max(20).optional(),
      }),
    });
    const parsed = schema.safeParse(raw);
    if (!parsed.success || (typeof raw === "object" && raw !== null && "web" in raw)) {
      throw new ConnectorError("oauth_client_invalid", "Import a Google Desktop application client, not a web client or a client using non-Google endpoints.");
    }
    return this.state.withLock(REGISTRY_KEY, async () => {
      const registry = await this.registry();
      const metadata = { id: randomUUID(), clientId: parsed.data.installed.client_id };
      await this.vault.set(clientKey(metadata.id), parsed.data.installed.client_secret);
      try {
        registry.clients.push(metadata);
        registry.defaultClient = metadata.id;
        await this.persist(registry);
      } catch (error) {
        try { await this.vault.delete(clientKey(metadata.id)); } catch {
          throw new ConnectorError("credential_cleanup_failed", "Client import failed and secure credential cleanup also failed. Check your operating system credential store.");
        }
        throw error;
      }
      return metadata;
    });
  }

  private validateGrant(grant: OAuthGrant): OAuthGrant {
    const parsed = grantSchema.safeParse(grant);
    if (!parsed.success || parsed.data.expiresAt <= this.now()) throw new ConnectorError("oauth_grant_invalid", "Authorization returned invalid or expired credentials.");
    return parsed.data;
  }

  async add(): Promise<Account> {
    const before = await this.registry();
    if (!before.defaultClient) throw new ConnectorError("oauth_client_required", "Import a Google Desktop OAuth client before adding an account.");
    const reference = before.defaultClient;
    const grant = this.validateGrant(await this.oauth.authorize(await this.client(reference, before)));
    if (!grant.refreshToken) throw new ConnectorError("refresh_token_missing", "Google did not grant offline access. Revoke the unused connector grant in Google Account settings if necessary, then add the account again.");
    return this.state.withLock(REGISTRY_KEY, async () => {
      const registry = await this.registry();
      const existing = registry.accounts.find((entry) => entry.subject === grant.identity.subject && entry.status === "active");
      if (existing) throw new ConnectorError("account_already_exists", "This Google identity is already enrolled. Use accounts reauth instead; its credentials were not replaced.", false, { accountId: existing.id });
      const record: AccountRecord = {
        id: randomUUID(), email: grant.identity.email, subject: grant.identity.subject,
        clientId: reference, generation: randomUUID(), scopes: grant.scopes,
        status: "active", credentialGenerations: [],
      };
      record.credentialGenerations.push(record.generation);
      const key = refreshKey(record.id, record.generation);
      await this.vault.set(key, grant.refreshToken!);
      try {
        registry.accounts.push(record);
        await this.persist(registry);
      } catch (error) {
        try { await this.vault.delete(key); } catch {
          throw new ConnectorError("credential_cleanup_failed", "Account enrollment failed and secure credential cleanup also failed.");
        }
        throw error;
      }
      this.cache(record, grant, grant.refreshToken!);
      return asAccount(record);
    });
  }

  async reauth(accountId: string): Promise<Account> {
    const before = await this.get(accountId);
    const grant = this.validateGrant(await this.oauth.authorize(await this.client(before.clientId)));
    if (grant.identity.subject !== before.subject) throw new ConnectorError("account_subject_mismatch", "The authorized Google identity does not match this account. No credentials were replaced.", false, { accountId });
    return this.state.withLock(`account-lifecycle-${accountId}`, async () => this.state.withLock(REGISTRY_KEY, async () => {
      const registry = await this.registry();
      const record = registry.accounts.find((entry) => entry.id === accountId && entry.status === "active");
      if (!record || record.generation !== before.generation || record.subject !== before.subject || record.clientId !== before.clientId) {
        throw new ConnectorError("account_generation_changed", "The account was removed or changed during authorization. Start a new explicit account command.", false, { accountId });
      }
      const refreshToken = grant.refreshToken ?? await this.vault.get(refreshKey(accountId, record.generation));
      if (!refreshToken) throw new ConnectorError("refresh_token_missing", "Google did not return an offline refresh token and the previous token is missing. Authorize offline access again.");
      const generation = randomUUID();
      const key = refreshKey(accountId, generation);
      await this.vault.set(key, refreshToken);
      try {
        record.generation = generation;
        record.email = grant.identity.email;
        record.scopes = grant.scopes;
        record.credentialGenerations.push(generation);
        await this.persist(registry);
      } catch (error) {
        try { await this.vault.delete(key); } catch {
          throw new ConnectorError("credential_cleanup_failed", "Reauthorization failed and secure credential cleanup also failed.");
        }
        throw error;
      }
      this.cache(record, grant, refreshToken);
      // Old generations remain referenced until removal, so an interrupted cleanup
      // never leaves a credential that removal cannot locate.
      return asAccount(record);
    }));
  }

  async remove(accountId: string): Promise<{ accountId: string; removed: true; providerRevoked: false }> {
    if (!idSchema.safeParse(accountId).success) throw unavailable(accountId);
    return this.state.withLock(`account-lifecycle-${accountId}`, async () => {
      const generations = await this.state.withLock(REGISTRY_KEY, async () => {
        const registry = await this.registry();
        const record = registry.accounts.find((entry) => entry.id === accountId);
        if (!record) throw unavailable(accountId);
        record.status = "removed";
        await this.persist(registry);
        this.accessTokens.delete(accountId);
        return [...record.credentialGenerations];
      });
      for (const generation of generations) {
        try {
          await this.vault.delete(refreshKey(accountId, generation));
          await this.state.withLock(REGISTRY_KEY, async () => {
            const registry = await this.registry();
            const record = registry.accounts.find((entry) => entry.id === accountId && entry.status === "removed");
            if (!record) throw unavailable(accountId);
            record.credentialGenerations = record.credentialGenerations.filter((entry) => entry !== generation);
            await this.persist(registry);
          });
        } catch {
          throw new ConnectorError("account_removed_cleanup_failed", "The account is unavailable, but secure credential deletion failed. Unlock the credential store and repeat accounts remove.", false, { accountId });
        }
      }
      return { accountId, removed: true, providerRevoked: false };
    });
  }

  private cache(account: Account, tokens: Tokens, refreshToken: string): void {
    this.accessTokens.set(account.id, {
      generation: account.generation, accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt, refreshFingerprint: fingerprint(refreshToken),
    });
  }

  async withAccess<T>(
    accountId: string,
    expectedGeneration: string | undefined,
    action: (account: Account, accessToken: string) => Promise<T>,
  ): Promise<T> {
    if (!idSchema.safeParse(accountId).success) throw unavailable(accountId);
    return this.state.withLock(`account-lifecycle-${accountId}`, async () => {
      let account: Account;
      let accessToken: string;
      try {
        account = await this.get(accountId);
        if (expectedGeneration !== undefined && account.generation !== expectedGeneration) {
          throw new ConnectorError("account_generation_changed", "This request belongs to an earlier account authorization and will not be dispatched.", false, { accountId, outcomeUnknown: false });
        }
        const key = refreshKey(accountId, account.generation);
        let refreshToken = await this.vault.get(key);
        if (!refreshToken) throw new ConnectorError("refresh_token_missing", "This account's offline credential is missing from secure storage. Run accounts reauth.", false, { accountId, outcomeUnknown: false });
        let cached = this.accessTokens.get(accountId);
        if (!cached || cached.generation !== account.generation || cached.expiresAt <= this.now() + 60_000 || cached.refreshFingerprint !== fingerprint(refreshToken)) {
          const rawTokens = await this.oauth.refresh(await this.client(account.clientId), refreshToken);
          const parsed = tokensSchema.safeParse(rawTokens);
          if (!parsed.success || parsed.data.expiresAt <= this.now()) throw new ConnectorError("oauth_token_invalid", "Google returned invalid or expired refreshed credentials.");
          const tokens = parsed.data;
          if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
            await this.vault.set(key, tokens.refreshToken);
            refreshToken = tokens.refreshToken;
          }
          if (tokens.scopes !== undefined) {
            account = await this.state.withLock(REGISTRY_KEY, async () => {
              const registry = await this.registry();
              const record = registry.accounts.find((entry) => entry.id === accountId && entry.status === "active" && entry.generation === account.generation);
              if (!record) throw unavailable(accountId);
              record.scopes = tokens.scopes!;
              await this.persist(registry);
              return asAccount(record);
            });
          }
          this.cache(account, tokens, refreshToken);
          cached = this.accessTokens.get(accountId)!;
        }
        accessToken = cached.accessToken;
      } catch (error) {
        const { code, message, retryable, ...details } = publicError(error);
        throw new ConnectorError(String(code), String(message), retryable === true, { ...details, accountId, outcomeUnknown: false });
      }
      return action(account, accessToken);
    });
  }
}
