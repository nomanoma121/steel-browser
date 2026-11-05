import { describe, expect, it, vi } from "vitest";

vi.mock("../env.js", () => ({ env: {} }));
vi.mock("./timezone-fetcher.service.js", () => ({
  TimezoneFetcher: class {},
}));

import { IProxyServer } from "../utils/proxy.js";
import { SessionService } from "./session.service.js";

/**
 * A proxy whose byte counters settle when it closes, mirroring proxy-chain: a
 * connection is credited on `connectionClosed`, and a long-lived tunnel stays
 * open until the browser goes away.
 */
function createProxyServer() {
  const proxy: IProxyServer & { close: ReturnType<typeof vi.fn> } = {
    url: "http://127.0.0.1:0",
    upstreamProxyUrl: "",
    txBytes: 1_000,
    rxBytes: 2_000,
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockImplementation(async () => {
      Object.assign(proxy, { txBytes: 3_000, rxBytes: 400_000 });
    }),
  };
  return proxy;
}

function createService({ withProxy = false } = {}) {
  const cdpService = {
    running: false,
    isRunning() {
      return this.running;
    },
    getUserAgent: () => "test-agent",
    getDimensions: () => ({ width: 1920, height: 1080 }),
    startNewSession: vi.fn(async () => {
      cdpService.running = true;
    }),
    endSession: vi.fn(async () => {
      cdpService.running = false;
    }),
    shutdown: vi.fn(async () => {
      cdpService.running = false;
    }),
  };
  const slot = {
    index: 1,
    cdpService,
    seleniumService: { close: vi.fn(), isRunning: () => false },
    sessionId: null as string | null,
  };
  let sessionEnded: (sessionId: string | undefined) => void = () => {};
  const browserPool = {
    maxSessions: 1,
    defaultSlot: slot,
    acquire: (id: string) => (slot.sessionId ? undefined : ((slot.sessionId = id), slot)),
    release: (id: string) => {
      if (slot.sessionId === id) slot.sessionId = null;
    },
    registerSessionEndedHook: (hook: typeof sessionEnded) => {
      sessionEnded = hook;
    },
  };
  const service = new SessionService({
    browserPool: browserPool as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });

  const proxy = withProxy ? createProxyServer() : undefined;
  if (proxy) service.setProxyFactory(() => proxy);
  const start = () =>
    service.startSession({ timezone: "UTC", proxyUrl: proxy ? "http://upstream.test" : undefined });

  return {
    service,
    cdpService,
    proxy,
    slot,
    start,
    sessionEnded: (id?: string) => sessionEnded(id),
  };
}

describe("SessionService.endSession proxy accounting", () => {
  it("reports the counters the proxy settles on close", async () => {
    const { service, proxy, start } = createService({ withProxy: true });
    const { id } = await start();

    const released = await service.endSession(id);

    expect(proxy!.close).toHaveBeenCalledTimes(1);
    expect(proxy!.close).toHaveBeenCalledWith(true);
    expect(released.proxyRxBytes).toBe(400_000);
    expect(released.proxyTxBytes).toBe(3_000);
  });

  it("closes the proxy only after the browser is torn down", async () => {
    const order: string[] = [];
    const { service, cdpService, proxy, start } = createService({ withProxy: true });
    const { id } = await start();
    cdpService.endSession.mockImplementation(async () => {
      cdpService.running = false;
      order.push("cdp");
    });
    proxy!.close.mockImplementation(async () => {
      order.push("proxy");
    });

    await service.endSession(id);

    expect(order).toEqual(["cdp", "proxy"]);
  });

  it("leaves the counters at zero when the session had no proxy", async () => {
    const { service, start } = createService();
    const { id } = await start();

    const released = await service.endSession(id);

    expect(released.proxyRxBytes).toBe(0);
    expect(released.proxyTxBytes).toBe(0);
  });
});

describe("SessionService browser crash", () => {
  it("releases the session and its slot when the browser ends on its own", async () => {
    const { service, cdpService, slot, start, sessionEnded } = createService();
    const { id } = await start();

    cdpService.running = false;
    sessionEnded(id);

    await vi.waitFor(() => expect(slot.sessionId).toBeNull());
    expect(service.getSessionDetails(id)?.status).toBe("released");
    expect((await start()).status).toBe("live");
  });
});
