#!/usr/bin/env node
// Log in with a local Chrome (passkeys etc.) and copy its cookies into Steel.
// Usage: node scripts/steel-login.mjs <url>
//   STEEL_API_URL    Steel API base URL. Unset: kubectl port-forward svc/steel-browser.
//   STEEL_NAMESPACE  Namespace for port-forward (default: steel-browser).
//   CHROME_PATH      Local Chrome binary.
//   STEEL_LOGIN_PROFILE  Local Chrome profile dir (default: ~/.steel-login).

import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const url = process.argv[2];
if (!url) {
  console.error("Usage: node scripts/steel-login.mjs <url>");
  process.exit(1);
}

const chromePath =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profileDir = process.env.STEEL_LOGIN_PROFILE ?? join(homedir(), ".steel-login");
const cleanups = [];

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 0;
  ws.addEventListener("message", ({ data }) => {
    const msg = JSON.parse(data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
  });
  const closed = () => {
    for (const p of pending.values()) p.reject(new Error(`${p.method}: connection closed`));
    pending.clear();
  };
  ws.addEventListener("close", closed);
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error(`Cannot connect to ${wsUrl}`)), {
      once: true,
    });
  });
  return {
    async send(method, params = {}) {
      await ready;
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { method, resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function chromeEndpoint() {
  const [port] = (await readFile(join(profileDir, "DevToolsActivePort"), "utf8")).split("\n");
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  return { ws: (await res.json()).webSocketDebuggerUrl };
}

async function openLocalChrome() {
  const running = await chromeEndpoint().catch(() => null);
  if (running) {
    const browser = cdp(running.ws);
    await browser.send("Target.createTarget", { url });
    return browser;
  }
  await rm(join(profileDir, "DevToolsActivePort"), { force: true });
  const chrome = spawn(
    chromePath,
    [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      url,
    ],
    { stdio: "ignore", detached: true },
  );
  chrome.unref();
  const failed = new Promise((_, reject) => chrome.on("error", reject));
  return cdp((await Promise.race([waitFor(chromeEndpoint, 30_000, "local Chrome"), failed])).ws);
}

async function steelApi() {
  if (process.env.STEEL_API_URL) return process.env.STEEL_API_URL.replace(/\/$/, "");
  const ns = process.env.STEEL_NAMESPACE ?? "steel-browser";
  const pf = spawn("kubectl", ["-n", ns, "port-forward", "svc/steel-browser", ":3000"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  cleanups.push(() => pf.kill());
  const port = await new Promise((resolve, reject) => {
    let out = "";
    pf.stdout.on("data", (chunk) => {
      out += chunk;
      const m = out.match(/127\.0\.0\.1:(\d+)/);
      if (m) resolve(m[1]);
    });
    pf.on("error", reject);
    pf.on("exit", (code) => reject(new Error(`kubectl port-forward exited (${code})`)));
  });
  return `http://127.0.0.1:${port}`;
}

// Network.Cookie -> CookieParam; an expires of -1 on a session cookie would delete it.
const toCookieParam = ({ size, session, sameParty, expires, ...cookie }) =>
  session ? cookie : { ...cookie, expires };

async function main() {
  const api = await steelApi();
  const health = await fetch(`${api}/v1/health`);
  if (!health.ok) throw new Error(`Steel API is not healthy: ${health.status}`);

  const local = await openLocalChrome();
  console.log(`Log in with the Chrome window that opened (profile: ${profileDir}).`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Press Enter when logged in... ");
  rl.close();

  const { cookies: raw } = await local.send("Storage.getCookies");
  const cookies = raw.map(toCookieParam);
  await local.send("Browser.close").catch(() => {});
  local.close();
  console.log(`Copied ${cookies.length} cookies from local Chrome.`);

  const { sessions } = await (await fetch(`${api}/v1/sessions`)).json();
  const live = sessions.filter((s) => s.status === "live");

  if (live.length === 0) {
    const res = await fetch(`${api}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionContext: { cookies } }),
    });
    if (!res.ok) throw new Error(`Create session failed: ${res.status} ${await res.text()}`);
    console.log(`Created session ${(await res.json()).id} with the cookies.`);
    return;
  }

  for (const session of live) {
    const remote = cdp(`${api.replace(/^http/, "ws")}/v1/sessions/${session.id}/cdp`);
    try {
      await remote.send("Storage.setCookies", { cookies });
      console.log(`Set cookies in session ${session.id}.`);
    } finally {
      remote.close();
    }
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => cleanups.forEach((fn) => fn()));
