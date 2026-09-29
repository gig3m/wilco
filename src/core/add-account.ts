import type { DatabaseSync } from "node:sqlite";
import { addAccount, removeAccount, type AccountSpec } from "./accounts.ts";
import type { CredentialStore } from "./credentials.ts";

const DEFAULT_ENDPOINT = "https://api.fastmail.com/jmap/session";

const KNOWN_OPTIONS = new Set(["key", "label", "accent", "endpoint", "code"]);

export interface AddAccountArgs {
  spec: AccountSpec;
  commit: boolean;
}

/** Parses the CLI. The token is NEVER an argument: argv is world-readable
 *  through /proc, so `--token` is refused with a pointer to the env var. */
export function parseAddAccountArgs(argv: string[]): AddAccountArgs {
  const opts = new Map<string, string>();
  let commit = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--commit") { commit = true; continue; }
    if (a === "--token") throw new Error("pass the token in WILCO_ACCOUNT_TOKEN, never on the command line");
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const name = a.slice(2);
    if (!KNOWN_OPTIONS.has(name)) throw new Error(`unknown option: ${a}`);
    if (i + 1 >= argv.length || argv[i + 1]!.startsWith("--")) throw new Error(`${a} requires a value`);
    opts.set(name, argv[++i]!);
  }
  const key = opts.get("key");
  const label = opts.get("label");
  if (!key) throw new Error("--key is required (lowercase letters, digits, dashes)");
  if (!label) throw new Error("--label is required");
  return {
    commit,
    spec: {
      key,
      label,
      accent: opts.get("accent") ?? "blue",
      provider: "jmap",
      endpoint: opts.get("endpoint") ?? DEFAULT_ENDPOINT,
      code: opts.get("code") || undefined,
    },
  };
}

/** Inserts the account row and seals its credential. If sealing fails the
 *  row is removed again, so a half-added account never survives. */
export async function addAccountWithCredential(
  db: DatabaseSync,
  store: CredentialStore,
  spec: AccountSpec,
  token: string,
): Promise<"stored"> {
  addAccount(db, spec);
  try {
    await store.put(spec.key, token);
  } catch (err) {
    removeAccount(db, spec.key);
    throw err;
  }
  return "stored";
}
