import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, rmdir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ConnectorError } from "./errors.js";

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function defaultStateDirectory(): string {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "copilot-google-connector");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "copilot-google-connector");
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "copilot-google-connector");
}

export class StateStore {
  constructor(public readonly directory: string) {}

  private path(key: string): string {
    if (!/^[a-zA-Z0-9._-]{1,160}$/.test(key)) throw new ConnectorError("invalid_state_key", "Invalid local state key.");
    return join(this.directory, `${key}.json`);
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
      throw new ConnectorError("unsafe_state_directory", "State directory must be a private directory, not a symlink.");
    }
  }

  async read<T>(key: string): Promise<T | undefined> {
    let handle;
    try {
      handle = await open(this.path(key), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new ConnectorError("invalid_state", "Local state file is invalid or too large.");
      return JSON.parse(await handle.readFile("utf8")) as T;
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("state_read_failed", "Cannot read local state. Do not reset corrupt state automatically.");
    } finally {
      await handle?.close();
    }
  }

  async write(key: string, value: unknown): Promise<void> {
    await this.initialize();
    const destination = this.path(key);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, destination);
      if (process.platform !== "win32") {
        const directoryHandle = await open(this.directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
    } catch (error) {
      try {
        await unlink(temporary);
      } catch (cleanup) {
        if (!isCode(cleanup, "ENOENT")) throw new ConnectorError("state_cleanup_failed", "Cannot clean up the interrupted state write.");
      }
      throw new ConnectorError("state_write_failed", "Cannot persist local state; the operation must not be repeated automatically.");
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await unlink(this.path(key));
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw new ConnectorError("state_remove_failed", "Cannot remove local state.");
    }
  }

  async withLock<T>(key: string, action: () => Promise<T>, timeoutMs = 90_000): Promise<T> {
    await this.initialize();
    const lockPath = `${this.path(key)}.lock`;
    const ownerPath = join(lockPath, "owner");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        const handle = await open(ownerPath, "wx", 0o600);
        try {
          await handle.writeFile(String(process.pid));
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw new ConnectorError("lock_failed", "Cannot acquire a private local state lock.");
        // Recovery is manual: two contenders deleting an orphan can race a new owner.
        try {
          const pid = Number(await readFile(ownerPath, "utf8"));
          if (Number.isSafeInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
            } catch (probe) {
              if (isCode(probe, "ESRCH")) {
                throw new ConnectorError("lock_orphaned", "A previous connector process left a lock. Stop all connector processes before removing this specific lock.", false, { lockPath });
              }
              if (!isCode(probe, "EPERM")) throw probe;
            }
          }
        } catch (ownerError) {
          if (ownerError instanceof ConnectorError) throw ownerError;
          if (!isCode(ownerError, "ENOENT")) throw new ConnectorError("lock_owner_invalid", "Cannot establish lock ownership. Stop connector processes before manual recovery.");
        }
        if (Date.now() >= deadline) throw new ConnectorError("lock_busy", "Another connector process holds the account/state lock. Retry after it completes.", true);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    }
    try {
      return await action();
    } finally {
      await unlink(ownerPath);
      await rmdir(lockPath);
    }
  }
}
