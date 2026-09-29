import { readFileSync } from "node:fs";

export class ConfigError extends Error {}

export type CredentialStoreKind = "db" | "env" | "keys";

export interface Config {
  dbPath: string;
  blobDir: string;
  port: number;
  baseUrl: string;
  bodyBaseUrl: string;
  masterKeySecret: string;
  credentialStore: CredentialStoreKind;
}

const REQUIRED = [
  "WILCO_DB_PATH",
  "WILCO_BLOB_DIR",
  "WILCO_PORT",
  "WILCO_BASE_URL",
  "WILCO_BODY_BASE_URL",
] as const;

const MIN_MASTER_SECRET_LENGTH = 16;

const CREDENTIAL_STORE_KINDS: readonly CredentialStoreKind[] = ["db", "env", "keys"];

export function loadConfig(env: Record<string, string | undefined>): Config {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new ConfigError(`missing required environment: ${missing.join(", ")}`);
  }

  const port = Number(env["WILCO_PORT"]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`WILCO_PORT is not a valid port: ${env["WILCO_PORT"]}`);
  }

  const baseUrl = stripSlash(env["WILCO_BASE_URL"]!);
  const bodyBaseUrl = stripSlash(env["WILCO_BODY_BASE_URL"]!);
  if (baseUrl === bodyBaseUrl) {
    throw new ConfigError(
      "WILCO_BODY_BASE_URL must be a different origin from WILCO_BASE_URL (spec 3.2)",
    );
  }

  const masterKeySecret = resolveMasterSecret(env);

  const rawStore = env["WILCO_CREDENTIAL_STORE"];
  const credentialStore: CredentialStoreKind = rawStore === undefined ? "db" : (rawStore as CredentialStoreKind);
  if (!CREDENTIAL_STORE_KINDS.includes(credentialStore)) {
    throw new ConfigError(
      `WILCO_CREDENTIAL_STORE must be one of ${CREDENTIAL_STORE_KINDS.join(", ")}, got: ${rawStore}`,
    );
  }

  return {
    dbPath: env["WILCO_DB_PATH"]!,
    blobDir: env["WILCO_BLOB_DIR"]!,
    port,
    baseUrl,
    bodyBaseUrl,
    masterKeySecret,
    credentialStore,
  };
}

/**
 * Resolve the operator-supplied master secret that unlocks the credential
 * store. `WILCO_MASTER_KEY_FILE` (a docker secret) wins over
 * `WILCO_MASTER_KEY` (a plain environment variable) — a file is not visible
 * in `docker inspect` or a crashed process's env dump.
 *
 * The secret itself must never appear in a thrown error: only the paths
 * and reasons that led to failure.
 */
export function resolveMasterSecret(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = defaultReadFile,
): string {
  const filePath = env["WILCO_MASTER_KEY_FILE"];
  let secret: string;

  if (filePath) {
    let contents: string;
    try {
      contents = readFile(filePath);
    } catch {
      throw new ConfigError(`could not read WILCO_MASTER_KEY_FILE at ${filePath}`);
    }
    secret = contents.replace(/\s+$/, "");
  } else if (env["WILCO_MASTER_KEY"]) {
    secret = env["WILCO_MASTER_KEY"]!;
  } else {
    throw new ConfigError(
      "no master secret supplied: set WILCO_MASTER_KEY_FILE (preferred, a docker secret) or WILCO_MASTER_KEY",
    );
  }

  if (secret.length < MIN_MASTER_SECRET_LENGTH) {
    throw new ConfigError(`master secret is too short: must be at least ${MIN_MASTER_SECRET_LENGTH} characters`);
  }

  return secret;
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

function stripSlash(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}
