import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("production stdio initializes and discovers tools without credentials or OAuth", async () => {
  const home = await mkdtemp(join(tmpdir(), "google-connector-stdio-"));
  const client = new Client({ name: "connector-offline-smoke", version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../cli.js", import.meta.url)), "serve"],
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, LOCALAPPDATA: home, XDG_STATE_HOME: home },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of ["accounts_list", "gmail_search", "gmail_create_draft", "calendar_list_calendars", "calendar_create_event", "calendar_delete_event", "calendar_rsvp", "operation_status", "operation_cancel"]) {
      assert.ok(names.includes(name), `missing ${name}`);
    }
    assert.equal(names.some((name) => /send|archive|delete_calendar|create_calendar|acl|approve|enroll/.test(name)), false);
    const accounts = await client.callTool({ name: "accounts_list", arguments: {} });
    assert.notEqual(accounts.isError, true);
    assert.deepEqual(accounts.structuredContent, { accounts: [] });
    const invalid = await client.callTool({ name: "gmail_read_message", arguments: { accountId: "missing", messageId: "not-real" } });
    assert.equal(invalid.isError, true);
    assert.doesNotMatch(JSON.stringify(invalid), /access_token|refresh_token|client_secret/);
    assert.doesNotMatch(stderr, /https:\/\/accounts\.google\.com|access_token|refresh_token/);
  } finally {
    await client.close();
    await transport.close();
    await rm(home, { recursive: true, force: true });
  }
});
