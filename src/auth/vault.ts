import { spawn } from "node:child_process";
import { ConnectorError } from "../core/errors.js";

export interface Vault {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const SERVICE = "copilot-google-connector";
const MAX_SECRET_BYTES = 64 * 1024;
const VAULT_TIMEOUT_MS = 15_000;

function validateKey(key: string): void {
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(key)) throw new ConnectorError("invalid_vault_key", "Invalid credential reference.");
}

function validateSecret(value: string, platform: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (!value || value.includes("\0") || bytes > (platform === "win32" ? 2560 : MAX_SECRET_BYTES)) {
    throw new ConnectorError("credential_size_limit", "Credential is empty, invalid, or exceeds the operating system's secure storage limit.");
  }
}

interface NativeEntry {
  getSecret(signal?: AbortSignal): Promise<unknown>;
  setSecret(value: Uint8Array, signal?: AbortSignal): Promise<void>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}
export type NativeLoader = () => Promise<{ AsyncEntry: new (service: string, key: string) => NativeEntry }>;

export class NativeVault implements Vault {
  constructor(
    private readonly platform: string = process.platform,
    private readonly load: NativeLoader = () => import("@napi-rs/keyring"),
  ) {}

  private async perform<T>(key: string, operation: (entry: NativeEntry, signal: AbortSignal) => Promise<T>): Promise<T> {
    validateKey(key);
    if (this.platform !== "darwin" && this.platform !== "win32") {
      throw new ConnectorError("vault_unavailable", "Native credential storage is enabled only on macOS and Windows. Linux requires secret-tool and a desktop Secret Service.");
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const { AsyncEntry } = await this.load();
          return operation(new AsyncEntry(SERVICE, key), controller.signal);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ConnectorError("vault_timeout", "Secure credential storage did not respond. Unlock your operating system credential store."));
          }, VAULT_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("vault_unavailable", "Secure credential storage failed. Check that the operating system credential store is installed and unlocked.");
    } finally {
      clearTimeout(timer);
    }
  }

  async get(key: string): Promise<string | undefined> {
    return this.perform(key, async (entry, signal) => {
      const value = await entry.getSecret(signal);
      if (value === undefined) return undefined;
      const limit = this.platform === "win32" ? 2560 : MAX_SECRET_BYTES;
      if ((value instanceof Uint8Array || Array.isArray(value)) && value.length > limit) {
        throw new ConnectorError("credential_size_limit", "Secure storage returned a credential exceeding the operating system's secure storage limit.");
      }
      let bytes: Uint8Array;
      if (value instanceof Uint8Array) {
        bytes = value;
      } else if (Array.isArray(value)) {
        // The pinned native binding returns number[] despite its Uint8Array declaration.
        const array = Array.from(value);
        if (!array.every((byte: unknown): byte is number => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
          throw new ConnectorError("vault_response_invalid", "Secure storage returned an invalid credential byte sequence.");
        }
        bytes = Uint8Array.from(array);
      } else {
        throw new ConnectorError("vault_response_invalid", "Secure storage returned an unsupported credential representation.");
      }
      let secret: string;
      try {
        secret = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new ConnectorError("credential_encoding_invalid", "The stored credential is not valid UTF-8. Restore its secure-storage entry through trusted account setup.");
      }
      validateSecret(secret, this.platform);
      return secret;
    });
  }

  async set(key: string, value: string): Promise<void> {
    validateSecret(value, this.platform);
    await this.perform(key, (entry, signal) => entry.setSecret(Buffer.from(value, "utf8"), signal));
  }

  async delete(key: string): Promise<void> {
    await this.perform(key, async (entry, signal) => { await entry.deleteCredential(signal); });
  }
}

export interface SecretToolResult { code: number | null; stdout: string; stderrPresent: boolean }
export type SecretToolRunner = (args: string[], input?: string) => Promise<SecretToolResult>;

export async function runSecretTool(args: string[], input?: string): Promise<SecretToolResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    let stderrPresent = false;
    const chunks: Buffer[] = [];
    const child = spawn("secret-tool", args, { shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const finish = (error?: ConnectorError, result?: SecretToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(result!);
    };
    const timer = setTimeout(() => finish(new ConnectorError("vault_timeout", "Secret Service did not respond. Unlock the desktop keyring and try again.")), VAULT_TIMEOUT_MS);
    child.on("error", () => finish(new ConnectorError("vault_unavailable", "secret-tool is unavailable. Install libsecret tools and unlock a desktop Secret Service.")));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_SECRET_BYTES + 1) finish(new ConnectorError("credential_size_limit", "Secure storage returned an oversized credential."));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrPresent = true;
      bytes += chunk.length;
      if (bytes > MAX_SECRET_BYTES + 1) finish(new ConnectorError("vault_unavailable", "Secret Service returned an invalid response."));
    });
    child.stdin.on("error", () => finish(new ConnectorError("vault_unavailable", "Cannot send a credential to Secret Service.")));
    child.on("close", (code) => finish(undefined, { code, stdout: Buffer.concat(chunks).toString("utf8"), stderrPresent }));
    child.stdin.end(input);
  });
}

export class SecretServiceVault implements Vault {
  constructor(private readonly run: SecretToolRunner = runSecretTool) {}

  private async perform(operation: "lookup" | "store" | "clear", key: string, value?: string): Promise<string | undefined> {
    validateKey(key);
    if (value !== undefined) validateSecret(value, "linux");
    const args = operation === "store"
      ? ["store", "--label=Copilot Google connector", "service", SERVICE, "credential", key]
      : [operation, "service", SERVICE, "credential", key];
    try {
      const result = await this.run(args, value);
      // Lookup exit 1 cannot safely distinguish a missing entry from a failed service.
      if (result.code !== 0 || result.stderrPresent) throw new ConnectorError("vault_unavailable", "Secret Service lookup or update failed. Check the desktop keyring; missing credentials require explicit reauthentication.");
      if (operation !== "lookup") {
        if (result.stdout !== "") throw new ConnectorError("vault_unavailable", "Secret Service returned an unexpected response.");
        return undefined;
      }
      const secret = result.stdout.replace(/\n$/, "");
      validateSecret(secret, "linux");
      return secret;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("vault_unavailable", "Secret Service failed. Install libsecret tools and unlock a desktop Secret Service.");
    }
  }

  get(key: string): Promise<string | undefined> { return this.perform("lookup", key); }
  async set(key: string, value: string): Promise<void> { await this.perform("store", key, value); }
  async delete(key: string): Promise<void> { await this.perform("clear", key); }
}

export function createVault(): Vault {
  if (process.platform === "linux") return new SecretServiceVault();
  return new NativeVault();
}
