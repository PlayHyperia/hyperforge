import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultDockerManager,
  DEFAULT_DEV_POSTGRES_PASSWORD,
  DockerManager,
  type DockerManagerConfig,
  validatePostgresContainerInspection,
} from "../docker-manager";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
}

describe("createDefaultDockerManager", () => {
  afterEach(() => {
    resetEnv();
    vi.restoreAllMocks();
  });

  it("uses development default password when POSTGRES_PASSWORD is missing", async () => {
    delete process.env.POSTGRES_PASSWORD;
    process.env.NODE_ENV = "development";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = createDefaultDockerManager();

    await expect(manager.getConnectionString()).resolves.toContain(
      `:${DEFAULT_DEV_POSTGRES_PASSWORD}@`,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      `[Database] POSTGRES_PASSWORD not set. Using default development password (${DEFAULT_DEV_POSTGRES_PASSWORD}).`,
    );
  });

  it("uses explicit postgres environment values when provided", async () => {
    process.env.NODE_ENV = "development";
    process.env.POSTGRES_CONTAINER = "my-postgres";
    process.env.POSTGRES_USER = "dev_user";
    process.env.POSTGRES_PASSWORD = "dev_password";
    process.env.POSTGRES_DB = "dev_db";
    process.env.POSTGRES_PORT = "6543";

    const manager = createDefaultDockerManager();
    await expect(manager.getConnectionString()).resolves.toBe(
      "postgresql://dev_user:dev_password@localhost:6543/dev_db",
    );
  });

  it("throws in production when POSTGRES_PASSWORD is missing", () => {
    delete process.env.POSTGRES_PASSWORD;
    process.env.NODE_ENV = "production";

    expect(() => createDefaultDockerManager()).toThrow(
      "POSTGRES_PASSWORD is required in production when using local PostgreSQL.",
    );
  });

  it("rejects malformed container names and ports before invoking Docker", () => {
    process.env.NODE_ENV = "development";
    process.env.POSTGRES_PASSWORD = "dev_password";
    process.env.POSTGRES_CONTAINER = "--unexpected-option";
    expect(() => createDefaultDockerManager()).toThrow(
      "POSTGRES_CONTAINER is not a valid Docker container name",
    );

    process.env.POSTGRES_CONTAINER = "hyperia-postgres";
    process.env.POSTGRES_PORT = "5488.5";
    expect(() => createDefaultDockerManager()).toThrow(
      "POSTGRES_PORT must be an integer between 1 and 65535",
    );
  });
});

const MANAGED_CONFIG: DockerManagerConfig = {
  containerName: "hyperia-launch-postgres",
  postgresUser: "hyperia",
  postgresPassword: "launch-password",
  postgresDb: "hyperia_launch",
  postgresPort: 5488,
  imageName: "postgres:16-alpine",
};

function matchingInspection(running = true) {
  return {
    Config: {
      Image: MANAGED_CONFIG.imageName,
      Env: [
        `POSTGRES_USER=${MANAGED_CONFIG.postgresUser}`,
        `POSTGRES_PASSWORD=${MANAGED_CONFIG.postgresPassword}`,
        `POSTGRES_DB=${MANAGED_CONFIG.postgresDb}`,
      ],
    },
    HostConfig: {
      PortBindings: {
        "5432/tcp": [{ HostIp: "", HostPort: "5488" }],
      },
    },
    State: { Running: running },
  };
}

describe("managed PostgreSQL container safety", () => {
  it("accepts only an exact existing-container configuration", () => {
    expect(() =>
      validatePostgresContainerInspection(MANAGED_CONFIG, matchingInspection()),
    ).not.toThrow();

    const mismatched = matchingInspection();
    mismatched.Config.Env[1] = "POSTGRES_PASSWORD=other-secret";
    mismatched.HostConfig.PortBindings["5432/tcp"][0].HostPort = "5432";

    expect(() =>
      validatePostgresContainerInspection(MANAGED_CONFIG, mismatched),
    ).toThrow("POSTGRES_PASSWORD, POSTGRES_PORT");
    try {
      validatePostgresContainerInspection(MANAGED_CONFIG, mismatched);
    } catch (error) {
      expect(String(error)).not.toContain("launch-password");
      expect(String(error)).not.toContain("other-secret");
    }
  });

  it("reuses a matching running container without creating or claiming it", async () => {
    const execDocker = vi.fn(async (args: string[]) => {
      if (args[0] === "ps") {
        return { stdout: `${MANAGED_CONFIG.containerName}\n`, stderr: "" };
      }
      if (args[0] === "inspect") {
        return { stdout: JSON.stringify([matchingInspection()]), stderr: "" };
      }
      if (args[0] === "exec") {
        return { stdout: "accepting connections\n", stderr: "" };
      }
      throw new Error(`unexpected docker call: ${args.join(" ")}`);
    });
    const spawnDocker = vi.fn(async () => {});
    const assertPortAvailable = vi.fn(async () => {});
    const manager = new DockerManager(MANAGED_CONFIG, {
      execDocker,
      spawnDocker,
      assertPortAvailable,
    });

    await manager.startPostgres();
    expect(spawnDocker).not.toHaveBeenCalled();
    expect(assertPortAvailable).not.toHaveBeenCalled();
    expect(execDocker).toHaveBeenCalledWith([
      "exec",
      MANAGED_CONFIG.containerName,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-U",
      MANAGED_CONFIG.postgresUser,
      "-d",
      MANAGED_CONFIG.postgresDb,
    ]);
    await manager.stopPostgres();
    expect(execDocker).not.toHaveBeenCalledWith([
      "stop",
      MANAGED_CONFIG.containerName,
    ]);
  });

  it("fails before create when the requested host port is occupied", async () => {
    const execDocker = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const spawnDocker = vi.fn(async () => {});
    const manager = new DockerManager(MANAGED_CONFIG, {
      execDocker,
      spawnDocker,
      assertPortAvailable: async () => {
        throw new Error("EADDRINUSE");
      },
    });

    await expect(manager.startPostgres()).rejects.toThrow(
      "host port 5488 is already in use",
    );
    expect(spawnDocker).not.toHaveBeenCalled();
  });

  it("creates only the requested container after a successful port preflight", async () => {
    const execDocker = vi.fn(async (args: string[]) => {
      if (args[0] === "ps") return { stdout: "", stderr: "" };
      if (args[0] === "exec") {
        return { stdout: "accepting connections\n", stderr: "" };
      }
      if (args[0] === "stop") return { stdout: "", stderr: "" };
      throw new Error(`unexpected docker call: ${args.join(" ")}`);
    });
    const spawnDocker = vi.fn(async () => {});
    const assertPortAvailable = vi.fn(async () => {});
    const manager = new DockerManager(MANAGED_CONFIG, {
      execDocker,
      spawnDocker,
      assertPortAvailable,
    });

    await manager.startPostgres();
    expect(assertPortAvailable).toHaveBeenCalledWith(5488);
    expect(spawnDocker).toHaveBeenCalledWith([
      "run",
      "-d",
      "--name",
      "hyperia-launch-postgres",
      "-e",
      "POSTGRES_USER=hyperia",
      "-e",
      "POSTGRES_PASSWORD=launch-password",
      "-e",
      "POSTGRES_DB=hyperia_launch",
      "-p",
      "5488:5432",
      "-v",
      "hyperia-launch-postgres-data:/var/lib/postgresql/data",
      "postgres:16-alpine",
    ]);
    await manager.stopPostgres();
    expect(execDocker).toHaveBeenCalledWith([
      "stop",
      "hyperia-launch-postgres",
    ]);
  });

  it("starts a stopped matching container and fails on a mismatched one", async () => {
    const stopped = matchingInspection(false);
    const execDocker = vi.fn(async (args: string[]) => {
      if (args[0] === "ps") {
        return { stdout: `${MANAGED_CONFIG.containerName}\n`, stderr: "" };
      }
      if (args[0] === "inspect") {
        return { stdout: JSON.stringify([stopped]), stderr: "" };
      }
      if (args[0] === "start" || args[0] === "stop") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "exec") {
        return { stdout: "accepting connections\n", stderr: "" };
      }
      throw new Error(`unexpected docker call: ${args.join(" ")}`);
    });
    const manager = new DockerManager(MANAGED_CONFIG, { execDocker });
    await manager.startPostgres();
    expect(execDocker).toHaveBeenCalledWith([
      "start",
      MANAGED_CONFIG.containerName,
    ]);

    const wrongImage = matchingInspection();
    wrongImage.Config.Image = "postgres:15-alpine";
    const mismatchedManager = new DockerManager(MANAGED_CONFIG, {
      execDocker: async (args) =>
        args[0] === "ps"
          ? { stdout: `${MANAGED_CONFIG.containerName}\n`, stderr: "" }
          : { stdout: JSON.stringify([wrongImage]), stderr: "" },
    });
    await expect(mismatchedManager.startPostgres()).rejects.toThrow(
      "does not match the requested configuration (image)",
    );
  });
});
