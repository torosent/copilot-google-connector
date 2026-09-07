#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { AccountManager } from "./auth/accounts.js";
import { WebAuthnApprovalGateway } from "./approval/index.js";
import { StateStore, defaultStateDirectory } from "./core/state.js";
import { ConnectorError, publicError } from "./core/errors.js";
import { serve } from "./server.js";

const help = `google-connector - local multi-account Gmail and Calendar MCP server

Commands:
  serve                         Run the stdio MCP server
  auth client import --file PATH Import your Google Desktop OAuth client into the OS vault
  accounts add                  Add an account using browser OAuth (user-invoked only)
  accounts list                 List configured accounts without revealing tokens
  accounts reauth ACCOUNT_ID     Reauthorize the same Google identity
  accounts remove ACCOUNT_ID     Remove local credentials (not provider-wide revocation)
  approvals enroll              Enroll an approval authenticator in a trusted browser
  doctor                        Show local setup status; does not contact Google
  config print                  Print an inert Copilot MCP configuration
  help                          Show this help

No send-mail or calendar/ACL administration tools exist. Never automate enrollment.
No command modifies Copilot configuration. Setup requires your explicit invocation.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: { file: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help || !positionals.length || positionals[0] === "help") {
    process.stdout.write(help);
    return;
  }
  const state = new StateStore(defaultStateDirectory());
  const accounts = new AccountManager(state);
  const [group, action, target] = positionals;
  let result: unknown;
  if (group === "serve" && positionals.length === 1) {
    await serve(state);
    return;
  } else if (group === "auth" && action === "client" && target === "import" && positionals.length === 3 && values.file) {
    result = await accounts.importClient(resolve(values.file));
  } else if (group === "accounts" && action === "list" && positionals.length === 2) {
    result = { accounts: (await accounts.list()).map(({ id, email, scopes }) => ({ accountId: id, email, scopes })) };
  } else if (group === "accounts" && action === "add" && positionals.length === 2) {
    result = await accounts.add();
  } else if (group === "accounts" && action === "reauth" && target && positionals.length === 3) {
    result = await accounts.reauth(target);
  } else if (group === "accounts" && action === "remove" && target && positionals.length === 3) {
    result = await accounts.remove(target);
  } else if (group === "approvals" && action === "enroll" && positionals.length === 2) {
    const approval = new WebAuthnApprovalGateway(state);
    try {
      result = await approval.enroll();
    } finally {
      await approval.close();
    }
  } else if (group === "doctor" && positionals.length === 1) {
    result = {
      node: process.version,
      platform: process.platform,
      stateDirectory: state.directory,
      credentialBackend: process.platform === "linux" ? "libsecret secret-tool / desktop Secret Service" : process.platform === "darwin" ? "macOS Keychain" : process.platform === "win32" ? "Windows Credential Manager" : "unsupported",
      accounts: (await accounts.list()).map(({ id, email, scopes }) => ({ accountId: id, email, scopes })),
      checksNotPerformed: ["vault read/write/unlock", "Google authentication or API connectivity", "browser/authenticator availability"],
    };
  } else if (group === "config" && action === "print" && positionals.length === 2) {
    result = {
      mcpServers: {
        "google-local": {
          type: "stdio",
          command: process.execPath,
          args: [fileURLToPath(import.meta.url), "serve"],
          env: {},
          tools: ["*"],
          timeout: 120000,
        },
      },
    };
  } else {
    throw new ConnectorError("invalid_command", "Unknown command or missing arguments. Run google-connector help.");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ error: publicError(error) })}\n`);
  process.exitCode = 1;
});
