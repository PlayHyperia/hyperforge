// These functions are self-contained: Playwright serializes them into the page.
export function installBrowserResourceTransferObserver({
  windowDurationMs = 10_000,
} = {}) {
  if (!Number.isSafeInteger(windowDurationMs) || windowDurationMs <= 0) {
    throw new Error(
      "Resource transfer window requires a positive integer duration",
    );
  }
  const total = {
    media: 0,
    nonMedia: 0,
    playlists: { resourceCount: 0, transferBytes: 0, encodedBodyBytes: 0 },
    segments: { resourceCount: 0, transferBytes: 0, encodedBodyBytes: 0 },
    observerSupported: false,
    observedResourceCount: 0,
    observerDroppedEntries: 0,
    invalidResourceCount: 0,
    timelineBufferFullEvents: 0,
    windowDurationMs,
    windowOverflowCount: 0,
    maximumMediaWindow: {
      transferBytes: 0,
      resourceCount: 0,
      startMs: 0,
      endMs: 0,
    },
  };
  // Bytes are charged when a completed resource is delivered to the observer,
  // just as the sample charges completed Resource Timing entries. This is not
  // a packet-level throughput measurement. The bounded queue retains no URLs.
  const mediaWindow = [];
  let mediaWindowBytes = 0;
  const record = (entries) => {
    const observedAtMs = performance.now();
    while (
      mediaWindow.length > 0 &&
      mediaWindow[0].observedAtMs <= observedAtMs - windowDurationMs
    ) {
      mediaWindowBytes -= mediaWindow.shift().transferBytes;
    }
    for (const entry of entries) {
      if (entry.entryType !== "resource") continue;
      total.observedResourceCount += 1;
      if (
        !Number.isSafeInteger(entry.transferSize) ||
        entry.transferSize < 0 ||
        !Number.isSafeInteger(entry.encodedBodySize) ||
        entry.encodedBodySize < 0
      ) {
        total.invalidResourceCount += 1;
        continue;
      }
      const pathname = new URL(entry.name, location.href).pathname;
      if (pathname.split("/").includes("live")) {
        total.media += entry.transferSize;
        if (mediaWindow.length >= 4096) {
          total.windowOverflowCount += 1;
        } else {
          mediaWindow.push({ observedAtMs, transferBytes: entry.transferSize });
          mediaWindowBytes += entry.transferSize;
          if (mediaWindowBytes > total.maximumMediaWindow.transferBytes) {
            total.maximumMediaWindow = {
              transferBytes: mediaWindowBytes,
              resourceCount: mediaWindow.length,
              startMs: mediaWindow[0].observedAtMs,
              endMs: observedAtMs,
            };
          }
        }
        const mediaType = pathname.endsWith(".m3u8")
          ? total.playlists
          : total.segments;
        mediaType.resourceCount += 1;
        mediaType.transferBytes += entry.transferSize;
        mediaType.encodedBodyBytes += entry.encodedBodySize;
      } else {
        total.nonMedia += entry.transferSize;
      }
    }
  };
  let observer = null;
  try {
    if (!PerformanceObserver.supportedEntryTypes.includes("resource")) {
      throw new Error("Resource observation is unsupported");
    }
    observer = new PerformanceObserver((list, _observer, options) => {
      // The optional count reports history lost before observer registration;
      // it is not the number discarded by the timeline after registration.
      total.observerDroppedEntries = Math.max(
        total.observerDroppedEntries,
        options?.droppedEntriesCount ?? 0,
      );
      record(list.getEntries());
    });
    // The observer queue is independent of getEntriesByType's finite timeline.
    // Keep only fixed-size aggregates; never grow or clear the page's buffer.
    observer.observe({ type: "resource", buffered: true });
    total.observerSupported = true;
  } catch {
    // Missing observations cannot be replaced with truncated timeline data.
    observer?.disconnect();
    observer = null;
  }
  performance.addEventListener("resourcetimingbufferfull", () => {
    total.timelineBufferFullEvents += 1;
  });
  Object.defineProperty(globalThis, "__hyperiaResourceTransfers", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: () => {
      // Drain once at the sample boundary. takeRecords removes these entries,
      // so the pending observer callback cannot count them a second time.
      if (observer) record(observer.takeRecords());
      return {
        ...total,
        snapshotAtMs: performance.now(),
        playlists: { ...total.playlists },
        segments: { ...total.segments },
        maximumMediaWindow: { ...total.maximumMediaWindow },
        pendingWindowResourceCount: mediaWindow.length,
        timelineResourceCount: performance.getEntriesByType("resource").length,
      };
    },
  });
}

export function readBrowserResourceTransfers() {
  if (typeof globalThis.__hyperiaResourceTransfers !== "function") {
    throw new Error("Browser resource-transfer observer was not installed");
  }
  return globalThis.__hyperiaResourceTransfers();
}
