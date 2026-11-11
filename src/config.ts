import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Credentials {
  id: string;
  token: string;
  /** Epoch millis. */
  expiry: number;
}

export interface Config {
  /** Your real Nando's account, imported from the website. Needed to place orders. */
  credentials?: Credentials;
  /** Throwaway anonymous session, used for browsing when not logged in. */
  anonymous?: Credentials;
  home?: { lat: number; lng: number; label?: string };
  /** Store to collect from. */
  storeId?: string;
  storeName?: string;
  /** place_order refuses baskets above this. */
  spendCapRands: number;
}

export class ConfigFileError extends Error {}

const DEFAULTS: Config = { spendCapRands: 500 };

export const configDir = resolve(process.env.NANDOS42_HOME || join(homedir(), ".nandos42"));
export const configPath = join(configDir, "config.json");

/**
 * Reads the config. A file that exists but can't be parsed is an error, never a
 * silent reset to defaults: that would raise the spend cap and, on the next save,
 * wipe the saved login.
 */
export function loadConfig(): Config {
  if (!existsSync(configPath)) return { ...DEFAULTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new ConfigFileError(`${configPath} is not valid JSON (${(e as Error).message}). Fix or delete it.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigFileError(`${configPath} should contain a JSON object. Fix or delete it.`);
  }
  return { ...DEFAULTS, ...(parsed as Partial<Config>) };
}

/** The spend cap in rands, or null if the configured value is unusable (ordering must then refuse). */
export function validSpendCap(cfg: Config): number | null {
  const cap = cfg.spendCapRands;
  return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : null;
}

/** Atomic write (temp file + rename) so a crash or concurrent read never sees half a file. */
export function saveConfig(cfg: Config): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const tmp = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, configPath);
  try {
    chmodSync(configPath, 0o600); // no-op on Windows
  } catch {
    /* best effort */
  }
}

/** Read-modify-write against the latest file contents. */
export function updateConfig(patch: Partial<Config>): Config {
  const cfg = { ...loadConfig(), ...patch };
  saveConfig(cfg);
  return cfg;
}
