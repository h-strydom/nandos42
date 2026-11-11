#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { NandosApi } from "./api.js";
import { configPath, loadConfig, updateConfig } from "./config.js";
import { serve } from "./server.js";

const HELP = `nandos42: unofficial Nando's South Africa MCP server

Usage:
  nandos42 [serve]          Run the MCP server on stdio (what your agent launches)
  nandos42 login            Link your Nando's account (needed to place orders)
  nandos42 logout           Forget your account
  nandos42 status           Show account and settings
  nandos42 cap <rands>      Set the maximum order total the agent may place (default R500)
  nandos42 home <lat> <lng> Save your location for finding the nearest store

Config lives in ${configPath}`;

const LOGIN_STEPS = `
Nando's login is protected by reCAPTCHA, so log in with your normal browser and
copy the session it creates:

  1. Open https://www.nandos.co.za/eat/order and log in.
  2. Open DevTools (F12) > Console and run:

       copy(localStorage.getItem('nandos-credentials-web'))

  3. Paste the result below and press Enter.

The session token is stored only on this machine (${configPath}), and is
refreshed automatically. Logging out on the website may invalidate it.
`;

async function main() {
  const [cmd = "serve", ...args] = process.argv.slice(2);
  switch (cmd) {
    case "serve":
      return serve();

    case "login": {
      console.log(LOGIN_STEPS);
      const raw = (await readHidden("Paste here (input is hidden): ")).trim().replace(/^'|'$/g, "");
      let creds: any;
      try {
        creds = JSON.parse(raw);
        if (typeof creds === "string") creds = JSON.parse(creds);
      } catch {
        throw new Error("That doesn't look like the JSON from step 2.");
      }
      if (!creds?.token || !creds?.id || !creds?.expiry) throw new Error("Missing id/token/expiry; copy the whole value.");
      const me = await new NandosApi().importCredentials({ id: creds.id, token: creds.token, expiry: creds.expiry });
      console.log(`\nLinked: ${me.name ?? "your account"}${me.verified === false ? " (warning: account not verified)" : ""}. You're good to order.`);
      return;
    }

    case "logout":
      new NandosApi().logout();
      console.log("Forgot your Nando's account.");
      return;

    case "status": {
      const cfg = loadConfig();
      let who = "not logged in";
      if (cfg.credentials) {
        try {
          const me = await new NandosApi().me();
          who = `${me.name ?? "logged in"} (${me.mobilePhoneNumber ?? "no phone"})`;
        } catch (e) {
          who = `login saved but not working: ${(e as Error).message}`;
        }
      }
      console.log({ account: who, store: cfg.storeName ?? null, home: cfg.home ?? null, spendCapRands: cfg.spendCapRands, config: configPath });
      return;
    }

    case "cap": {
      const n = Number(args[0]);
      if (!Number.isFinite(n) || n <= 0) throw new Error("Usage: nandos42 cap <rands>");
      updateConfig({ spendCapRands: n });
      console.log(`Spend cap set to R${n}.`);
      return;
    }

    case "home": {
      const [lat, lng] = args.map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("Usage: nandos42 home <lat> <lng>");
      updateConfig({ home: { lat, lng } });
      console.log("Home location saved.");
      return;
    }

    default:
      console.log(HELP);
  }
}

/** Prompt without echoing what's typed/pasted, so the token doesn't land in terminal scrollback. */
async function readHidden(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const out = rl as unknown as { _writeToOutput?: (s: string) => void };
  process.stdout.write(prompt);
  out._writeToOutput = () => {};
  try {
    return await rl.question("");
  } finally {
    rl.close();
    process.stdout.write("\n");
  }
}

main().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
