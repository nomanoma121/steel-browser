import Fastify from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";
import { schemas } from "../../plugins/schemas.js";
import { FileService } from "../../services/file.service.js";
import { SessionServiceError, type SessionService } from "../../services/session.service.js";
import filesRoutes from "./files.routes.js";

async function app() {
  const server = Fastify();
  server.decorate("steelBrowserConfig", {});
  server.decorate("sessionService", {
    resolveLiveSession: (id: string) => {
      throw id === "ended"
        ? new SessionServiceError("ended", 410, "session_ended")
        : new SessionServiceError("not found", 404, "session_not_found");
    },
  } as unknown as SessionService);
  for (const schema of schemas) server.addSchema(schema);
  await server.register(filesRoutes, { prefix: "/v1" });
  return server;
}

describe("files routes", () => {
  afterEach(() => vi.restoreAllMocks());

  test("rejects sessions that are not live without creating file storage", async () => {
    const getInstance = vi.spyOn(FileService, "getInstance");
    const server = await app();

    const unknown = await server.inject({ method: "GET", url: "/v1/sessions/unknown/files" });
    const ended = await server.inject({ method: "GET", url: "/v1/sessions/ended/files.zip" });

    expect(unknown.statusCode).toBe(404);
    expect(ended.statusCode).toBe(410);
    expect(getInstance).not.toHaveBeenCalled();
    await server.close();
  });
});
