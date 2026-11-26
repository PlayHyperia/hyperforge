/**
 * Docker Container Manager
 *
 * This module automates Docker container lifecycle management for local development.
 * It handles starting, stopping, and health-checking PostgreSQL containers so developers
 * don't need to manually manage database infrastructure.
 *
 * **Key Features**:
 * - Automatic PostgreSQL container creation and startup
 * - Health checks before returning control to caller
 * - Idempotent operations (safe to call multiple times)
 * - Graceful shutdown tracking (only stops containers we started)
 * - Persistent data volumes to survive container restarts
 *
 * **Container Lifecycle**:
 * 1. `checkDockerRunning()`: Verify Docker daemon is accessible
 * 2. `checkPostgresRunning()`: Check if container exists and is running
 * 3. `startPostgres()`: Create container if needed, start it, wait for ready
 * 4. `waitForPostgres()`: Poll pg_isready until accepting connections
 * 5. `stopPostgres()`: Stop container on shutdown (only if we started it)
 *
 * **Data Persistence**:
 * Creates a named Docker volume (e.g., "hyperia-postgres-data") that persists
 * database data across container restarts. This means player data survives server
 * restarts in development.
 *
 * **Configuration**:
 * All settings come from environment variables:
 * - `POSTGRES_CONTAINER`: Container name (default: hyperia-postgres)
 * - `POSTGRES_USER`: Database user (default: hyperia)
 * - `POSTGRES_PASSWORD`: Database password (default in development: hyperia_dev_password)
 * - `POSTGRES_DB`: Database name (default: hyperia)
 * - `POSTGRES_PORT`: Host port mapping (default: 5488)
 * - `POSTGRES_IMAGE`: Docker image (default: postgres:16-alpine)
 *
 * **Hot Reload Support**:
 * Tracks whether we started the container (`containerStartedByUs`). If the container
 * was already running (from a previous session or manual start), we leave it running
 * during hot reload to avoid connection interruption.
 *
 * **Error Handling**:
 * - Throws if Docker daemon is not running
 * - Rejects existing containers whose image, credentials, database, or port do not match
 * - Rejects occupied host ports before attempting to create a container
 * - Throws if PostgreSQL fails to become ready within timeout
 * - Never adopts an unrelated container or local PostgreSQL service
 *
 * **Referenced by**: index.ts (server startup and shutdown)
 */

import { spawn, execFile, type ChildProcess } from "child_process";
import net from "node:net";
import { promisify } from "util";
import { resolveDockerBinary } from "./resolveDockerBinary.js";

const execFileAsync = promisify(execFile);
const DOCKER_BIN = resolveDockerBinary();

export const DEFAULT_DEV_POSTGRES_PASSWORD = "hyperia_dev_password";

async function execDocker(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const operation = execFileAsync(DOCKER_BIN, args);
  if (args.length === 2 && args[0] === "stop") {
    observePostgresStopChild(operation.child);
  }
  return operation;
}

/** Observe only our already-created stop child; never signal or await it here. */
export function observePostgresStopChild(child: ChildProcess): void {
  const started = performance.now();
  let sequence = 0;
  const record = (
    phase: "created" | "spawn" | "exit" | "close" | "error",
    code: number | null = null,
    signal: NodeJS.Signals | null = null,
    errorCode: string | null = null,
  ) => {
    if (sequence >= 5) return;
    sequence++;
    try {
      process.stdout.write(
        JSON.stringify({
          event: "server-postgres-stop-child",
          schemaVersion: 1,
          pid: process.pid,
          childPid: child.pid ?? null,
          sequence,
          phase,
          code,
          signal,
          errorCode,
          at: Date.now(),
          elapsedMs: performance.now() - started,
        }) + "\n",
      );
    } catch {
      // Preserve the existing execFile promise and shutdown failure semantics.
    }
  };
  record("created");
  child.once("spawn", () => record("spawn"));
  child.once("exit", (code, signal) => record("exit", code, signal));
  child.once("close", (code, signal) => record("close", code, signal));
  child.once("error", (error: NodeJS.ErrnoException) => {
    const code = error.code;
    record(
      "error",
      null,
      null,
      typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : null,
    );
  });
}

/**
 * Docker container configuration
 */
export interface DockerManagerConfig {
  containerName: string;
  postgresUser: string;
  postgresPassword: string;
  postgresDb: string;
  postgresPort: number;
  imageName: string;
}

export interface DockerContainerInspection {
  Config?: {
    Env?: string[];
    Image?: string;
  };
  HostConfig?: {
    PortBindings?: Record<
      string,
      Array<{ HostIp?: string; HostPort?: string }> | null
    >;
  };
  State?: {
    Running?: boolean;
  };
}

type ExecDocker = (
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;
type SpawnDocker = (args: string[]) => Promise<void>;

export interface DockerManagerDependencies {
  execDocker?: ExecDocker;
  spawnDocker?: SpawnDocker;
  assertPortAvailable?: (port: number) => Promise<void>;
}

function parseContainerEnvironment(values: string[] = []): Map<string, string> {
  return new Map(
    values.map((value) => {
      const separator = value.indexOf("=");
      return separator < 0
        ? [value, ""]
        : [value.slice(0, separator), value.slice(separator + 1)];
    }),
  );
}

export function validatePostgresContainerInspection(
  config: DockerManagerConfig,
  inspection: DockerContainerInspection,
): void {
  const mismatches: string[] = [];
  if (inspection.Config?.Image !== config.imageName) {
    mismatches.push("image");
  }

  const environment = parseContainerEnvironment(inspection.Config?.Env);
  if (environment.get("POSTGRES_USER") !== config.postgresUser) {
    mismatches.push("POSTGRES_USER");
  }
  if (environment.get("POSTGRES_PASSWORD") !== config.postgresPassword) {
    mismatches.push("POSTGRES_PASSWORD");
  }
  if (environment.get("POSTGRES_DB") !== config.postgresDb) {
    mismatches.push("POSTGRES_DB");
  }

  const bindings = inspection.HostConfig?.PortBindings?.["5432/tcp"];
  if (
    !Array.isArray(bindings) ||
    bindings.length !== 1 ||
    bindings[0]?.HostPort !== String(config.postgresPort)
  ) {
    mismatches.push("POSTGRES_PORT");
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Existing PostgreSQL container "${config.containerName}" does not match the requested configuration (${mismatches.join(", ")}). Choose a matching POSTGRES_CONTAINER, remove the conflicting container manually, or use an explicit DATABASE_URL with USE_LOCAL_POSTGRES=false.`,
    );
  }
}

export function assertValidDockerManagerConfig(
  config: DockerManagerConfig,
): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(config.containerName)) {
    throw new Error("POSTGRES_CONTAINER is not a valid Docker container name");
  }
  if (!config.postgresUser.trim()) {
    throw new Error("POSTGRES_USER must not be empty");
  }
  if (!config.postgresPassword) {
    throw new Error("POSTGRES_PASSWORD must not be empty");
  }
  if (!config.postgresDb.trim()) {
    throw new Error("POSTGRES_DB must not be empty");
  }
  if (
    !Number.isSafeInteger(config.postgresPort) ||
    config.postgresPort < 1 ||
    config.postgresPort > 65535
  ) {
    throw new Error("POSTGRES_PORT must be an integer between 1 and 65535");
  }
  if (!config.imageName.trim()) {
    throw new Error("POSTGRES_IMAGE must not be empty");
  }
}

export async function assertTcpPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => reject(error));
    server.listen({ host: "0.0.0.0", port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

function spawnDockerAttached(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(DOCKER_BIN, args, { stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Docker command failed with code ${code}`));
    });
    child.on("error", reject);
  });
}

/**
 * Manages Docker containers for local development
 * Handles PostgreSQL container lifecycle automatically
 */
export class DockerManager {
  private config: DockerManagerConfig;
  private containerStartedByUs = false;
  private readonly runDocker: ExecDocker;
  private readonly spawnDocker: SpawnDocker;
  private readonly assertPortAvailable: (port: number) => Promise<void>;

  /**
   * Constructs a new DockerManager
   *
   * @param config - Docker container configuration
   *
   * @public
   */
  constructor(
    config: DockerManagerConfig,
    dependencies: DockerManagerDependencies = {},
  ) {
    assertValidDockerManagerConfig(config);
    this.config = config;
    this.runDocker = dependencies.execDocker ?? execDocker;
    this.spawnDocker = dependencies.spawnDocker ?? spawnDockerAttached;
    this.assertPortAvailable =
      dependencies.assertPortAvailable ?? assertTcpPortAvailable;
  }

  /**
   * Checks if the Docker daemon is running
   *
   * Executes `docker info` to verify Docker is accessible.
   *
   * @throws Error if Docker is not running or not installed
   *
   * @public
   */
  async checkDockerRunning(): Promise<void> {
    await this.runDocker(["info"]);
  }

  private async inspectPostgresContainer(): Promise<{
    exists: boolean;
    running: boolean;
  }> {
    const { stdout: existsOut } = await this.runDocker([
      "ps",
      "-a",
      "--filter",
      `name=^/${this.config.containerName}$`,
      "--format",
      "{{.Names}}",
    ]);
    if (existsOut.trim() !== this.config.containerName) {
      return { exists: false, running: false };
    }

    const { stdout } = await this.runDocker([
      "inspect",
      this.config.containerName,
    ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(
        `Docker returned invalid inspection data for PostgreSQL container "${this.config.containerName}"`,
      );
    }
    if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0]) {
      throw new Error(
        `Docker returned no unique inspection record for PostgreSQL container "${this.config.containerName}"`,
      );
    }

    const inspection = parsed[0] as DockerContainerInspection;
    validatePostgresContainerInspection(this.config, inspection);
    return {
      exists: true,
      running: inspection.State?.Running === true,
    };
  }

  /**
   * Checks if the PostgreSQL container is running
   *
   * Inspects the container state to determine if it exists and is running.
   *
   * @returns true if container exists and is running, false otherwise
   *
   * @public
   */
  async checkPostgresRunning(): Promise<boolean> {
    return (await this.inspectPostgresContainer()).running;
  }

  /**
   * Starts the PostgreSQL container
   *
   * Creates a new container if it doesn't exist, or starts an existing stopped container.
   * Waits for PostgreSQL to be ready before returning (polls pg_isready).
   *
   * @throws Error if container fails to start or become ready
   *
   * @public
   */
  async startPostgres(): Promise<void> {
    const state = await this.inspectPostgresContainer();
    if (!state.exists) {
      try {
        await this.assertPortAvailable(this.config.postgresPort);
      } catch {
        throw new Error(
          `PostgreSQL host port ${this.config.postgresPort} is already in use while configured container "${this.config.containerName}" does not exist. Choose an unused POSTGRES_PORT, select the matching POSTGRES_CONTAINER, or use an explicit DATABASE_URL with USE_LOCAL_POSTGRES=false.`,
        );
      }
      await this.createPostgresContainer();
      this.containerStartedByUs = true;
    } else if (!state.running) {
      try {
        await this.runDocker(["start", this.config.containerName]);
      } catch (error) {
        throw new Error(
          `Failed to start PostgreSQL container "${this.config.containerName}" on host port ${this.config.postgresPort}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.containerStartedByUs = true;
    }

    await this.waitForPostgres();
  }

  private async createPostgresContainer(): Promise<void> {
    const dockerArgs = [
      "run",
      "-d",
      "--name",
      this.config.containerName,
      "-e",
      `POSTGRES_USER=${this.config.postgresUser}`,
      "-e",
      `POSTGRES_PASSWORD=${this.config.postgresPassword}`,
      "-e",
      `POSTGRES_DB=${this.config.postgresDb}`,
      "-p",
      `${this.config.postgresPort}:5432`,
      "-v",
      `${this.config.containerName}-data:/var/lib/postgresql/data`,
      this.config.imageName,
    ];

    try {
      await this.spawnDocker(dockerArgs);
    } catch (error) {
      throw new Error(
        `Docker PostgreSQL container creation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async waitForPostgres(maxAttempts: number = 30): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const { stdout } = await this.runDocker([
          "exec",
          this.config.containerName,
          "pg_isready",
          // The image entrypoint briefly runs an initialization server on a
          // Unix socket before restarting PostgreSQL in its final TCP mode.
          // Probing the socket can therefore return a false-ready result and
          // hand the application a connection reset during that restart.
          "-h",
          "127.0.0.1",
          "-U",
          this.config.postgresUser,
          "-d",
          this.config.postgresDb,
        ]);

        if (stdout.includes("accepting connections")) {
          return;
        }
      } catch {
        // pg_isready returns non-zero when not ready - this is expected, retry
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error("PostgreSQL failed to become ready within timeout period");
  }

  /**
   * Stops the PostgreSQL container
   *
   * Only stops the container if this DockerManager instance started it.
   * If the container was already running when we connected, it's left running.
   *
   * @public
   */
  async stopPostgres(): Promise<void> {
    if (!this.containerStartedByUs) {
      return;
    }

    await this.runDocker(["stop", this.config.containerName]);
  }

  /**
   * Gets the PostgreSQL connection string
   *
   * Constructs the connection URL only from the configuration that was already
   * validated against the managed container.
   *
   * @returns PostgreSQL connection string (postgresql://user:pass@host:port/database)
   *
   * @public
   */
  async getConnectionString(): Promise<string> {
    const user = encodeURIComponent(this.config.postgresUser);
    const password = encodeURIComponent(this.config.postgresPassword);
    const database = encodeURIComponent(this.config.postgresDb);
    return `postgresql://${user}:${password}@localhost:${this.config.postgresPort}/${database}`;
  }
}

/**
 * Creates a DockerManager with default configuration from environment variables
 *
 * Reads configuration from environment variables with sensible defaults:
 * - POSTGRES_CONTAINER: Container name (default: hyperia-postgres)
 * - POSTGRES_USER: Database user (default: hyperia)
 * - POSTGRES_PASSWORD: Database password (default in development: hyperia_dev_password)
 * - POSTGRES_DB: Database name (default: hyperia)
 * - POSTGRES_PORT: Host port (default: 5488)
 * - POSTGRES_IMAGE: Docker image (default: postgres:16-alpine)
 *
 * @returns Configured DockerManager instance
 *
 * @public
 */
export function createDefaultDockerManager(): DockerManager {
  const postgresPassword =
    process.env.POSTGRES_PASSWORD || DEFAULT_DEV_POSTGRES_PASSWORD;

  if (!process.env.POSTGRES_PASSWORD) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "POSTGRES_PASSWORD is required in production when using local PostgreSQL.",
      );
    }

    console.warn(
      `[Database] POSTGRES_PASSWORD not set. Using default development password (${DEFAULT_DEV_POSTGRES_PASSWORD}).`,
    );
  }

  if (!postgresPassword) {
    throw new Error(
      "POSTGRES_PASSWORD is required when using local PostgreSQL.",
    );
  }
  const config: DockerManagerConfig = {
    containerName: process.env.POSTGRES_CONTAINER || "hyperia-postgres",
    postgresUser: process.env.POSTGRES_USER || "hyperia",
    postgresPassword: postgresPassword,
    postgresDb: process.env.POSTGRES_DB || "hyperia",
    postgresPort: Number(process.env.POSTGRES_PORT || "5488"),
    imageName: process.env.POSTGRES_IMAGE || "postgres:16-alpine",
  };

  return new DockerManager(config);
}
