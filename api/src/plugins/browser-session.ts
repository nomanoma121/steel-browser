import { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { env } from "../env.js";
import { CookieStore, sessionCookieJars } from "../services/cookie-store.service.js";
import { SessionService } from "../services/session.service.js";

const browserSessionPlugin: FastifyPluginAsync = async (fastify, _options) => {
  const sessionService = new SessionService({
    browserPool: fastify.browserPool,
    logger: fastify.log,
  });
  fastify.decorate("sessionService", sessionService);

  const cookieStore = env.COOKIE_STORE_PATH
    ? new CookieStore(env.COOKIE_STORE_PATH, sessionCookieJars(sessionService), fastify.log)
    : null;
  if (cookieStore) {
    await cookieStore.load();
    cookieStore.start(5_000);
    fastify.addHook("preClose", () => cookieStore.stop());
  }
  fastify.decorate("cookieStore", cookieStore);
};

export default fp(browserSessionPlugin, "5.x");
