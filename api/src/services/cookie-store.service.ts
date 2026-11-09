import { readFile, rename, writeFile } from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";
import type { Protocol } from "puppeteer-core";
import type { SessionService } from "./session.service.js";

type Cookie = Protocol.Network.Cookie;
type CookieParam = Protocol.Network.CookieParam;

export interface CookieJar {
  id: string;
  getCookies(): Promise<Cookie[]>;
  setCookies(cookies: CookieParam[]): Promise<void>;
}

const key = (c: Cookie) => JSON.stringify([c.name, c.domain, c.path, c.partitionKey ?? null]);

// An expires of -1 on a session cookie would delete it.
const toCookieParam = ({
  size,
  session,
  sameParty,
  partitionKeyOpaque,
  expires,
  ...cookie
}: Cookie): CookieParam => (session ? cookie : { ...cookie, expires });

// Rounded so float noise in expires does not bounce a cookie between sessions.
const fingerprint = (c: Cookie) =>
  JSON.stringify({ ...toCookieParam(c), expires: c.session ? undefined : Math.round(c.expires) });
const isExpired = (c: Cookie, now: number) =>
  !c.session && c.expires > 0 && c.expires * 1000 <= now;
const deletion = (c: Cookie): CookieParam => ({ ...toCookieParam(c), value: "", expires: 1 });

/**
 * Shares cookies between all live sessions and persists them to a file.
 * Each sync diffs every session against its last snapshot and copies the
 * changes (including deletions) to the store and the other sessions.
 */
export class CookieStore {
  private readonly cookies = new Map<string, Cookie>();
  private readonly seen = new Map<string, Map<string, Cookie>>();
  private syncing?: Promise<void>;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly path: string,
    private readonly jars: () => CookieJar[],
    private readonly logger: FastifyBaseLogger,
  ) {}

  async load(): Promise<void> {
    const raw = await readFile(this.path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "[]";
      throw error;
    });
    const now = Date.now();
    for (const cookie of JSON.parse(raw) as Cookie[]) {
      if (!isExpired(cookie, now)) this.cookies.set(key(cookie), cookie);
    }
    this.logger.info(`[CookieStore] Loaded ${this.cookies.size} cookies from ${this.path}`);
  }

  // Cookies passed at session creation come last so they win.
  withStoredCookies<T>(cookies: T[] = []): (T | CookieParam)[] {
    return [...[...this.cookies.values()].map(toCookieParam), ...cookies];
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.sync(), intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.sync();
  }

  sync(): Promise<void> {
    this.syncing ??= this.syncOnce()
      .catch((error) => this.logger.error({ err: error }, "[CookieStore] Sync failed"))
      .finally(() => {
        this.syncing = undefined;
      });
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    const jars = this.jars();
    const ids = new Set(jars.map((jar) => jar.id));
    for (const id of this.seen.keys()) if (!ids.has(id)) this.seen.delete(id);

    let dirty = false;
    for (const jar of jars) {
      const current = await jar.getCookies().catch(() => undefined);
      if (!current) continue;
      const now = new Map(current.map((c) => [key(c), c]));
      const prev = this.seen.get(jar.id);
      this.seen.set(jar.id, now);

      // A new session is compared with the store and given what it lacks.
      const base = prev ?? this.cookies;
      const changed = current.filter((c) => {
        const old = base.get(key(c));
        return !old || fingerprint(old) !== fingerprint(c);
      });
      const removed = prev ? [...prev].filter(([k]) => !now.has(k)).map(([, c]) => c) : [];
      if (!prev) {
        const missing = [...this.cookies].filter(([k]) => !now.has(k)).map(([, c]) => c);
        if (missing.length) {
          await jar.setCookies(missing.map(toCookieParam)).catch(() => undefined);
          for (const c of missing) now.set(key(c), c);
        }
      }
      if (!changed.length && !removed.length) continue;

      dirty = true;
      for (const c of changed) this.cookies.set(key(c), c);
      for (const c of removed) this.cookies.delete(key(c));
      const params = [...changed.map(toCookieParam), ...removed.map(deletion)];
      for (const other of jars) {
        if (other === jar) continue;
        if (
          !(await other.setCookies(params).then(
            () => true,
            () => false,
          ))
        )
          continue;
        const otherSeen = this.seen.get(other.id);
        for (const c of changed) otherSeen?.set(key(c), c);
        for (const c of removed) otherSeen?.delete(key(c));
      }
    }
    if (dirty) await this.save();
  }

  private async save(): Promise<void> {
    const now = Date.now();
    const cookies = [...this.cookies.values()].filter((c) => !isExpired(c, now));
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(cookies), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}

export const sessionCookieJars = (sessionService: SessionService) => (): CookieJar[] =>
  sessionService
    .getActiveSessions()
    .filter((session) => session.status === "live" && !session.isSelenium)
    .map((session) => ({
      id: session.id,
      getCookies: () => session.cdpService.getCookies(),
      async setCookies(cookies) {
        const browser = session.cdpService.getBrowserInstance();
        if (!browser) throw new Error("Browser not initialized");
        const cdp = await browser.target().createCDPSession();
        try {
          await cdp.send("Storage.setCookies", { cookies });
        } finally {
          await cdp.detach().catch(() => undefined);
        }
      },
    }));
