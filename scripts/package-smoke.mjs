import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "google-connector-package-"));
const consumer = join(temporary, "consumer");
const home = join(temporary, "home");
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this through npm run smoke:package.");
let client;
let transport;
try {
  await mkdir(consumer);
  await mkdir(home);
  const packed = await exec(process.execPath, [npmCli, "--silent", "pack", "--json", "--pack-destination", temporary], { cwd: root, maxBuffer: 2 * 1024 * 1024 });
  const packs = JSON.parse(packed.stdout);
  assert.equal(packs.length, 1);
  const pack = packs[0];
  const paths = pack.files.map((entry) => entry.path);
  assert.ok(paths.includes("dist/cli.js"));
  assert.ok(paths.includes("README.md"));
  assert.equal(paths.some((path) => /(^|\/)(src|test|node_modules|\.env)(\/|$)|credentials.*\.json|client_secret.*\.json|\.log$/.test(path)), false);
  await exec(process.execPath, [npmCli, "install", "--prefix", consumer, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", resolve(temporary, pack.filename)], { cwd: consumer, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
  const entry = join(consumer, "node_modules", "copilot-google-connector", "dist", "cli.js");
  const help = await exec(process.execPath, [entry, "help"], { cwd: consumer });
  assert.match(help.stdout, /local multi-account/);
  const environment = { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, LOCALAPPDATA: home, XDG_STATE_HOME: home };
  const printed = await exec(process.execPath, [entry, "config", "print"], { cwd: consumer, env: environment });
  const configuration = JSON.parse(printed.stdout).mcpServers["google-local"];
  assert.equal(configuration.type, "stdio");
  assert.equal(configuration.command, process.execPath);
  assert.deepEqual(configuration.args, [await realpath(entry), "serve"]);
  client = new Client({ name: "production-install-smoke", version: "1.0.0" }, { capabilities: {} });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "serve"],
    cwd: consumer,
    env: environment,
    stderr: "pipe",
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "gmail_create_draft"));
  assert.ok(tools.some((tool) => tool.name === "calendar_delete_event"));
  const result = await client.callTool({ name: "accounts_list", arguments: {} });
  assert.deepEqual(result.structuredContent, { accounts: [] });
  assert.deepEqual(await readdir(home), [], "Help, config printing, discovery and empty-account listing must not create user state.");
  console.log(`Production-only tarball install passed; ${tools.length} MCP tools discovered without credentials.`);
} finally {
  await client?.close();
  await transport?.close();
  await rm(temporary, { recursive: true, force: true });
}
