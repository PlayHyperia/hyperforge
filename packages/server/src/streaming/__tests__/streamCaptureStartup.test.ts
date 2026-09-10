import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initStreamCapture } from "../stream-capture";

const originalCaptureEnabled = process.env.STREAMING_CAPTURE_ENABLED;
const serverMainSource = readFileSync(
  fileURLToPath(new URL("../../main.ts", import.meta.url)),
  "utf8",
);
const captureWorkerSource = readFileSync(
  fileURLToPath(new URL("../../../scripts/stream-to-rtmp.ts", import.meta.url)),
  "utf8",
);

afterEach(() => {
  if (originalCaptureEnabled === undefined) {
    delete process.env.STREAMING_CAPTURE_ENABLED;
  } else {
    process.env.STREAMING_CAPTURE_ENABLED = originalCaptureEnabled;
  }
});

describe("stream capture startup authority", () => {
  it("does not report success until the listener readiness boundary resolves", async () => {
    process.env.STREAMING_CAPTURE_ENABLED = "true";
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const bridge = {
      start: vi.fn(),
      waitForServerReady: vi.fn(() => ready),
    };

    let settled = false;
    const initialization = initStreamCapture({
      bridge,
      port: 18_765,
      readyTimeoutMs: 1_000,
    }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();

    expect(bridge.start).toHaveBeenCalledWith(18_765);
    expect(bridge.waitForServerReady).toHaveBeenCalledWith(1_000);
    expect(settled).toBe(false);

    resolveReady();
    await expect(initialization).resolves.toBe(true);
  });

  it("propagates a listener-readiness failure instead of claiming capture", async () => {
    process.env.STREAMING_CAPTURE_ENABLED = "true";
    const bridge = {
      start: vi.fn(),
      waitForServerReady: vi
        .fn()
        .mockRejectedValue(new Error("listener unavailable")),
    };

    await expect(initStreamCapture({ bridge, port: 18_765 })).rejects.toThrow(
      "listener unavailable",
    );
  });

  it("does not construct or start capture when explicitly disabled", async () => {
    process.env.STREAMING_CAPTURE_ENABLED = "false";
    const bridge = {
      start: vi.fn(),
      waitForServerReady: vi.fn(),
    };

    await expect(initStreamCapture({ bridge })).resolves.toBe(false);
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.waitForServerReady).not.toHaveBeenCalled();
  });

  it("awaits capture readiness and makes an enabled failure fatal in server startup", () => {
    const captureInitialization = serverMainSource.slice(
      serverMainSource.indexOf(
        "// Step 10: Initialize stream capture pipeline",
      ),
      serverMainSource.indexOf("// Register shutdown handlers"),
    );
    expect(captureInitialization).toContain(
      "const captureStarted = await initStreamCapture()",
    );
    expect(captureInitialization).toContain(
      "Streaming capture initialization failed",
    );
    expect(captureInitialization).not.toContain("continuing without capture");
  });

  it("awaits the bridge listener in both external capture modes", () => {
    const listenerWaits = captureWorkerSource.match(
      /await bridge\.waitForServerReady\(\);/g,
    );
    expect(listenerWaits).toHaveLength(2);
    expect(
      captureWorkerSource.indexOf("bridge.start(BRIDGE_PORT);"),
    ).toBeLessThan(
      captureWorkerSource.indexOf("await bridge.waitForServerReady();"),
    );
    const webCodecsStart = captureWorkerSource.indexOf(
      "bridge.startWebCodecs(BRIDGE_PORT);",
    );
    expect(webCodecsStart).toBeGreaterThan(-1);
    expect(
      captureWorkerSource.indexOf(
        "await bridge.waitForServerReady();",
        webCodecsStart,
      ),
    ).toBeGreaterThan(webCodecsStart);
  });
});
