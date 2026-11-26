import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright";
import { resolveMediaExecutable } from "../packages/server/src/streaming/media-runtime.mjs";
import {
  installBrowserResourceTransferObserver,
  readBrowserResourceTransfers,
} from "./duel-browser-resource-transfers.mjs";
import { evaluateFullTopologyBrowserPerformance } from "./duel-full-topology-browser-performance-policy.mjs";

test("measures actual media transfers after the browser resource timeline fills", async () => {
  const encoder = resolveMediaExecutable({ tool: "ffmpeg" });
  const segment = execFileSync(
    encoder.path,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=64x64:rate=30",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-f",
      "mpegts",
      "pipe:1",
    ],
    { timeout: 15_000, maxBuffer: 1024 * 1024 },
  );
  assert.ok(segment.length > 0);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    response.setHeader("Cache-Control", "no-store");
    if (pathname === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<!doctype html><title>Resource accounting regression</title>",
      );
    } else if (pathname === "/live/segment.ts") {
      response.setHeader("Content-Type", "video/mp2t");
      response.end(segment);
    } else if (pathname === "/live/stream.m3u8") {
      response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      response.end(
        "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n",
      );
    } else {
      response.setHeader("Content-Type", "text/plain");
      response.end("Actual non-media HTTP response\n");
    }
  });
  let browser;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(installBrowserResourceTransferObserver);
    await page.addInitScript(() =>
      performance.setResourceTimingBufferSize(250),
    );
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const fetchResources = async (prefix, count, targetPage = page) =>
      targetPage.evaluate(
        async ({ prefix, count }) => {
          for (let offset = 0; offset < count; offset += 10) {
            await Promise.all(
              Array.from(
                { length: Math.min(10, count - offset) },
                async (_, index) => {
                  const response = await fetch(
                    `${prefix}?request=${offset + index}`,
                  );
                  if (!response.ok) throw new Error(`HTTP ${response.status}`);
                  await response.arrayBuffer();
                },
              ),
            );
          }
        },
        { prefix, count },
      );
    await fetchResources("/live/stream.m3u8", 1);
    await fetchResources("/live/segment.ts", 1);
    await fetchResources("/poll", 350);
    const timelineCount = await page.evaluate(
      () => performance.getEntriesByType("resource").length,
    );
    assert.equal(
      timelineCount,
      250,
      "exercise the explicit 250-entry cap seen in the fail-before run",
    );
    const before = await page.evaluate(readBrowserResourceTransfers);
    await fetchResources("/live/stream.m3u8", 3);
    await fetchResources("/live/segment.ts", 3);
    const after = await page.evaluate(readBrowserResourceTransfers);
    assert.ok(
      after.media > before.media,
      "media counters must advance despite the full resource timeline",
    );
    assert.equal(
      after.segments.resourceCount - before.segments.resourceCount,
      3,
    );
    assert.equal(
      after.segments.encodedBodyBytes - before.segments.encodedBodyBytes,
      segment.length * 3,
    );
    assert.equal(after.observerSupported, true);
    assert.equal(after.observerDroppedEntries, 0);
    assert.equal(after.invalidResourceCount, 0);
    assert.ok(after.observedResourceCount >= 358);
    assert.ok(after.timelineBufferFullEvents > 0);
    assert.equal(after.timelineResourceCount, 250);
    const reread = await page.evaluate(readBrowserResourceTransfers);
    assert.ok(reread.snapshotAtMs >= after.snapshotAtMs);
    assert.deepEqual(
      { ...reread, snapshotAtMs: after.snapshotAtMs },
      after,
      "snapshot reads do not count resource entries twice",
    );
    await page.evaluate(() => performance.clearResourceTimings());
    await fetchResources("/live/segment.ts", 2);
    const afterClear = await page.evaluate(readBrowserResourceTransfers);
    assert.equal(
      afterClear.segments.resourceCount,
      after.segments.resourceCount + 2,
    );
    assert.equal(
      afterClear.segments.encodedBodyBytes,
      after.segments.encodedBodyBytes + segment.length * 2,
    );
    assert.ok(
      afterClear.media > after.media,
      "clearing the browser timeline cannot reset the measurement",
    );
    assert.equal(afterClear.maximumMediaWindow.transferBytes, afterClear.media);
    assert.equal(afterClear.windowDurationMs, 10_000);
    assert.equal(afterClear.windowOverflowCount, 0);

    const windowPage = await browser.newPage();
    await windowPage.addInitScript(installBrowserResourceTransferObserver, {
      windowDurationMs: 1_000,
    });
    await windowPage.goto(`http://127.0.0.1:${server.address().port}`);
    await fetchResources("/live/segment.ts", 8, windowPage);
    const peak = await windowPage.evaluate(readBrowserResourceTransfers);
    assert.equal(peak.maximumMediaWindow.transferBytes, peak.media);
    assert.equal(peak.maximumMediaWindow.resourceCount, 8);
    await windowPage.waitForTimeout(1_100);
    const idle = await windowPage.evaluate(readBrowserResourceTransfers);
    assert.equal(
      idle.pendingWindowResourceCount,
      0,
      "old resource records are evicted, not accumulated for the session",
    );
    await fetchResources("/live/segment.ts", 2, windowPage);
    const later = await windowPage.evaluate(readBrowserResourceTransfers);
    assert.ok(
      later.media > peak.media,
      "lifetime totals remain visible across multiple windows",
    );
    assert.equal(later.pendingWindowResourceCount, 2);
    assert.deepEqual(
      later.maximumMediaWindow,
      peak.maximumMediaWindow,
      "a later quiet sample cannot erase an earlier burst",
    );
    assert.equal(later.windowOverflowCount, 0);

    const overflowPage = await browser.newPage();
    await overflowPage.addInitScript(installBrowserResourceTransferObserver, {
      windowDurationMs: 60_000,
    });
    await overflowPage.goto(`http://127.0.0.1:${server.address().port}`);
    await fetchResources("/live/stream.m3u8", 4_100, overflowPage);
    const overflow = await overflowPage.evaluate(readBrowserResourceTransfers);
    assert.equal(
      overflow.playlists.resourceCount,
      4_100,
      "overflow does not discard lifetime accounting",
    );
    assert.equal(overflow.pendingWindowResourceCount, 4_096);
    assert.equal(
      overflow.windowOverflowCount,
      4,
      "the real observer queue fails closed at its exact bound",
    );
    assert.ok(
      evaluateFullTopologyBrowserPerformance({
        resourceTimingWindowOverflowCount: overflow.windowOverflowCount,
      }).some((message) =>
        message.startsWith("resourceTimingWindowOverflowCount=4"),
      ),
    );

    const unobservedPage = await browser.newPage();
    await unobservedPage.goto(`http://127.0.0.1:${server.address().port}`);
    await assert.rejects(
      () => unobservedPage.evaluate(readBrowserResourceTransfers),
      /observer was not installed/,
    );
  } finally {
    await browser?.close();
    server.closeAllConnections();
    if (server.listening)
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
});
