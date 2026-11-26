import { describe, expect, it, vi } from "vitest";

import type { DockerManager } from "../../infrastructure/docker/docker-manager";
import { prepareDatabaseConnectionTarget } from "../database";

function makeDockerManager(
  overrides: Partial<
    Pick<
      DockerManager,
      | "checkDockerRunning"
      | "startPostgres"
      | "getConnectionString"
      | "stopPostgres"
    >
  > = {},
): DockerManager {
  return {
    checkDockerRunning: vi.fn(async () => {}),
    startPostgres: vi.fn(async () => {}),
    getConnectionString: vi.fn(
      async () => "postgresql://hyperia@localhost:5488/hyperia",
    ),
    stopPostgres: vi.fn(async () => {}),
    ...overrides,
  } as unknown as DockerManager;
}

describe("prepareDatabaseConnectionTarget", () => {
  it("prepares and returns only the exact managed local target", async () => {
    const dockerManager = makeDockerManager();

    await expect(
      prepareDatabaseConnectionTarget(
        { useLocalPostgres: true, databaseUrl: undefined },
        () => dockerManager,
      ),
    ).resolves.toEqual({
      connectionString: "postgresql://hyperia@localhost:5488/hyperia",
      dockerManager,
    });
    expect(dockerManager.checkDockerRunning).toHaveBeenCalledOnce();
    expect(dockerManager.startPostgres).toHaveBeenCalledOnce();
    expect(dockerManager.getConnectionString).toHaveBeenCalledOnce();
  });

  it("fails closed when the managed target cannot start", async () => {
    const dockerManager = makeDockerManager({
      startPostgres: vi.fn(async () => {
        throw new Error("configured port is occupied");
      }),
    });

    await expect(
      prepareDatabaseConnectionTarget(
        { useLocalPostgres: true, databaseUrl: undefined },
        () => dockerManager,
      ),
    ).rejects.toThrow(
      "Managed local PostgreSQL failed closed: configured port is occupied",
    );
    expect(dockerManager.getConnectionString).not.toHaveBeenCalled();
  });

  it("uses an explicit URL without touching Docker", async () => {
    const createDockerManager = vi.fn(() => makeDockerManager());

    await expect(
      prepareDatabaseConnectionTarget(
        {
          useLocalPostgres: true,
          databaseUrl: "postgresql://launch.example/hyperia",
        },
        createDockerManager,
      ),
    ).resolves.toEqual({
      connectionString: "postgresql://launch.example/hyperia",
    });
    expect(createDockerManager).not.toHaveBeenCalled();
  });

  it("rejects an absent target instead of guessing a default service", async () => {
    await expect(
      prepareDatabaseConnectionTarget({
        useLocalPostgres: false,
        databaseUrl: undefined,
      }),
    ).rejects.toThrow(
      "No database configuration: set DATABASE_URL or USE_LOCAL_POSTGRES=true",
    );
  });
});
