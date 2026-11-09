import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Protocol } from "puppeteer-core";
import { CookieStore, type CookieJar } from "./cookie-store.service.js";

type Cookie = Protocol.Network.Cookie;

const logger = { info: vi.fn(), error: vi.fn() } as any;

function cookie(name: string, value: string, extra: Partial<Cookie> = {}): Cookie {
  return {
    name,
    value,
    domain: "example.com",
    path: "/",
    expires: -1,
    size: name.length + value.length,
    httpOnly: false,
    secure: true,
    session: true,
    priority: "Medium",
    sameParty: false,
    sourceScheme: "Secure",
    sourcePort: 443,
    ...extra,
  };
}

// Mimics Chrome: an expires in the past deletes, a missing expires makes a session cookie.
function jar(id: string, cookies: Cookie[] = []) {
  const store = new Map(cookies.map((c) => [c.name, c]));
  const fake: CookieJar & { store: Map<string, Cookie>; setCookies: ReturnType<typeof vi.fn> } = {
    id,
    store,
    getCookies: async () => [...store.values()],
    setCookies: vi.fn(async (params: Protocol.Network.CookieParam[]) => {
      for (const { expires, ...p } of params) {
        if (expires !== undefined && expires > 0 && expires * 1000 < Date.now()) {
          store.delete(p.name);
          continue;
        }
        store.set(
          p.name,
          cookie(p.name, p.value, {
            ...(p as Partial<Cookie>),
            expires: expires ?? -1,
            session: expires === undefined,
          }),
        );
      }
    }),
  };
  return fake;
}

async function setup(stored: Cookie[] = []) {
  const path = join(await mkdtemp(join(tmpdir(), "cookie-store-")), "cookies.json");
  await writeFile(path, JSON.stringify(stored));
  const jars: ReturnType<typeof jar>[] = [];
  const store = new CookieStore(path, () => jars, logger);
  await store.load();
  const saved = async () =>
    (JSON.parse(await readFile(path, "utf8")) as Cookie[])
      .map((c) => `${c.name}=${c.value}`)
      .sort();
  return { store, jars, saved };
}

const values = (j: ReturnType<typeof jar>) =>
  [...j.store.values()].map((c) => `${c.name}=${c.value}`).sort();

describe("CookieStore", () => {
  it("puts stored cookies before the ones given at creation", async () => {
    const { store } = await setup([cookie("a", "1")]);
    expect(store.cookiesForNewSession("s", [{ name: "a", value: "2" }])).toEqual([
      expect.objectContaining({ name: "a", value: "1" }),
      { name: "a", value: "2" },
    ]);
  });

  it("drops expired cookies and keeps session cookies when loading", async () => {
    const past = Date.now() / 1000 - 60;
    const future = Date.now() / 1000 + 3600;
    const { store } = await setup([
      cookie("gone", "1", { session: false, expires: past }),
      cookie("kept", "1", { session: false, expires: future }),
      cookie("session", "1"),
    ]);
    const names = store.cookiesForNewSession("s").map((c) => c.name);
    expect(names.sort()).toEqual(["kept", "session"]);
    const session = store.cookiesForNewSession("s").find((c) => c.name === "session")!;
    expect(session).not.toHaveProperty("expires");
  });

  it("starts with an empty store when the file is missing", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "cookie-store-")), "cookies.json");
    const store = new CookieStore(path, () => [], logger);
    await store.load();
    expect(store.cookiesForNewSession("s")).toEqual([]);
  });

  it("fills a new session from the store and learns the cookies it brought", async () => {
    const { store, jars, saved } = await setup([cookie("a", "1")]);
    const other = jar("other", [cookie("a", "1")]);
    jars.push(other);
    await store.sync();
    const fresh = jar("fresh", [cookie("login", "x")]);
    jars.push(fresh);
    await store.sync();

    expect(values(fresh)).toEqual(["a=1", "login=x"]);
    expect(values(other)).toEqual(["a=1", "login=x"]);
    expect(await saved()).toEqual(["a=1", "login=x"]);
  });

  it("keeps a deletion made before the new session's first sync", async () => {
    const { store, jars, saved } = await setup([cookie("x", "1"), cookie("y", "1")]);
    const fresh = jar("fresh");
    await fresh.setCookies(store.cookiesForNewSession("fresh"));
    fresh.store.delete("x");
    jars.push(fresh);
    await store.sync();
    expect(values(fresh)).toEqual(["y=1"]);
    expect(await saved()).toEqual(["y=1"]);
  });

  it("copies store changes made while a session was starting", async () => {
    const { store, jars, saved } = await setup([cookie("x", "1"), cookie("y", "1")]);
    const a = jar("a", [cookie("x", "1"), cookie("y", "1")]);
    jars.push(a);
    await store.sync();
    const fresh = jar("fresh");
    await fresh.setCookies(store.cookiesForNewSession("fresh"));
    a.store.set("x", cookie("x", "2"));
    a.store.delete("y");
    a.store.set("z", cookie("z", "1"));
    await store.sync();
    jars.push(fresh);
    await store.sync();
    expect(values(fresh)).toEqual(["x=2", "z=1"]);
    expect(values(a)).toEqual(["x=2", "z=1"]);
    expect(await saved()).toEqual(["x=2", "z=1"]);
  });

  it("lets a starting session's own change win over the store's", async () => {
    const { store, jars } = await setup([cookie("x", "1")]);
    const a = jar("a", [cookie("x", "1")]);
    jars.push(a);
    await store.sync();
    const fresh = jar("fresh");
    await fresh.setCookies(store.cookiesForNewSession("fresh"));
    a.store.set("x", cookie("x", "2"));
    await store.sync();
    fresh.store.set("x", cookie("x", "3"));
    jars.push(fresh);
    await store.sync();
    expect(values(a)).toEqual(["x=3"]);
    expect(values(fresh)).toEqual(["x=3"]);
  });

  it("copies changes and deletions to the other sessions and the file", async () => {
    const { store, jars, saved } = await setup();
    const a = jar("a", [cookie("x", "1"), cookie("y", "1")]);
    const b = jar("b");
    jars.push(a, b);
    await store.sync();
    expect(values(b)).toEqual(["x=1", "y=1"]);

    a.store.set("x", cookie("x", "2"));
    a.store.delete("y");
    await store.sync();
    expect(values(b)).toEqual(["x=2"]);
    expect(await saved()).toEqual(["x=2"]);

    b.store.set("z", cookie("z", "1"));
    await store.sync();
    expect(values(a)).toEqual(["x=2", "z=1"]);
  });

  it("does not echo cookies it copied back to their source", async () => {
    const { store, jars } = await setup();
    const a = jar("a", [cookie("x", "1", { session: false, expires: Date.now() / 1000 + 3600.4 })]);
    const b = jar("b");
    jars.push(a, b);
    await store.sync();
    a.setCookies.mockClear();
    b.setCookies.mockClear();
    await store.sync();
    await store.sync();
    expect(a.setCookies).not.toHaveBeenCalled();
    expect(b.setCookies).not.toHaveBeenCalled();
  });

  it("keeps the store when the last session goes away", async () => {
    const { store, jars, saved } = await setup();
    jars.push(jar("a", [cookie("x", "1")]));
    await store.sync();
    jars.length = 0;
    await store.sync();
    expect(await saved()).toEqual(["x=1"]);
    expect(store.cookiesForNewSession("s").map((c) => c.name)).toEqual(["x"]);
  });
});
