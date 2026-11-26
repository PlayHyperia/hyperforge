/**
 * Vitest Setup File
 *
 * Configures the test environment with required global mocks.
 */

import { expect, vi, beforeEach, afterEach } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";

// Extend Vitest's expect with jest-dom matchers
expect.extend(matchers);

// three.webgpu expects WebGPU enum-like globals to exist at module import time.
// JSDOM/Node do not provide them, so we polyfill minimal constants for tests.
if (!("GPUShaderStage" in globalThis)) {
  (globalThis as Record<string, unknown>).GPUShaderStage = {
    VERTEX: 0x1,
    FRAGMENT: 0x2,
    COMPUTE: 0x4,
  };
}

if (!("GPUBufferUsage" in globalThis)) {
  (globalThis as Record<string, unknown>).GPUBufferUsage = {
    MAP_READ: 0x1,
    MAP_WRITE: 0x2,
    COPY_SRC: 0x4,
    COPY_DST: 0x8,
    INDEX: 0x10,
    VERTEX: 0x20,
    UNIFORM: 0x40,
    STORAGE: 0x80,
    INDIRECT: 0x100,
    QUERY_RESOLVE: 0x200,
  };
}

if (!("GPUTextureUsage" in globalThis)) {
  (globalThis as Record<string, unknown>).GPUTextureUsage = {
    COPY_SRC: 0x1,
    COPY_DST: 0x2,
    TEXTURE_BINDING: 0x4,
    STORAGE_BINDING: 0x8,
    RENDER_ATTACHMENT: 0x10,
  };
}

if (!("GPUMapMode" in globalThis)) {
  (globalThis as Record<string, unknown>).GPUMapMode = {
    READ: 0x1,
    WRITE: 0x2,
  };
}

if (!("GPUColorWrite" in globalThis)) {
  (globalThis as Record<string, unknown>).GPUColorWrite = {
    RED: 0x1,
    GREEN: 0x2,
    BLUE: 0x4,
    ALPHA: 0x8,
    ALL: 0xf,
  };
}

// ============================================================================
// BROWSER API MOCKS
// ============================================================================

// Mock DataTransfer for drag events (jsdom doesn't support it)
class MockDataTransfer implements DataTransfer {
  dropEffect: DataTransfer["dropEffect"] = "none";
  effectAllowed: DataTransfer["effectAllowed"] = "all";
  readonly items = [] as unknown as DataTransferItemList;
  readonly types: readonly string[] = [];
  readonly files = [] as unknown as FileList;

  clearData(): void {}
  getData(): string {
    return "";
  }
  setData(): void {}
  setDragImage(): void {}
}

// Patch DragEvent to include dataTransfer
const originalDragEvent = globalThis.DragEvent;
class PatchedDragEvent extends Event {
  readonly dataTransfer: DataTransfer;

  constructor(type: string, eventInitDict?: DragEventInit) {
    super(type, eventInitDict);
    this.dataTransfer = eventInitDict?.dataTransfer ?? new MockDataTransfer();
  }
}

Object.defineProperty(globalThis, "DragEvent", {
  value: PatchedDragEvent,
  writable: true,
});

// Mock window.matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock IntersectionObserver
class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = "";
  readonly scrollMargin: string = "";
  readonly thresholds: ReadonlyArray<number> = [];

  constructor(
    _callback: IntersectionObserverCallback,
    _options?: IntersectionObserverInit,
  ) {}

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn().mockReturnValue([]);
}

Object.defineProperty(window, "IntersectionObserver", {
  writable: true,
  value: MockIntersectionObserver,
});

// Mock ResizeObserver
class MockResizeObserver implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  value: MockResizeObserver,
});

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  };
})();

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
});

// ============================================================================
// PERFORMANCE MOCKS
// ============================================================================

// Mock performance.now for throttle testing
let mockNow = 0;
const originalPerformanceNow = performance.now.bind(performance);

export function setMockPerformanceNow(time: number): void {
  mockNow = time;
}

export function advanceMockPerformanceNow(delta: number): void {
  mockNow += delta;
}

export function resetMockPerformanceNow(): void {
  mockNow = 0;
}

// Conditionally mock performance.now - tests can opt-in
export function enablePerformanceMock(): void {
  vi.spyOn(performance, "now").mockImplementation(() => mockNow);
}

export function disablePerformanceMock(): void {
  vi.spyOn(performance, "now").mockImplementation(originalPerformanceNow);
}

// ============================================================================
// @HYPERIA/SHARED SETUP
// ============================================================================

// Tests rely on real @hyperforge/shared implementation; item data can be
// populated per-test via the ITEMS map for deterministic UI rendering.

// ============================================================================
// TEST LIFECYCLE
// ============================================================================

beforeEach(() => {
  // Clear localStorage between tests
  localStorageMock.clear();
  vi.clearAllMocks();
  resetMockPerformanceNow();
});

afterEach(() => {
  vi.restoreAllMocks();
});
