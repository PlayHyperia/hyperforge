import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerCsrfProtection } from "../csrf.js";

const openServers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe("CSRF token delivery", () => {
  it("returns a non-cacheable secure double-submit token", async () => {
    const server = Fastify();
    openServers.push(server);
    registerCsrfProtection(server);

    const response = await server.inject({
      method: "GET",
      url: "/api/csrf-token",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const token = response.json<{ token: string }>().token;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(response.headers["set-cookie"]).toMatch(
      new RegExp(
        `^csrf-token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400(?:; Secure)?$`,
      ),
    );
  });
});
