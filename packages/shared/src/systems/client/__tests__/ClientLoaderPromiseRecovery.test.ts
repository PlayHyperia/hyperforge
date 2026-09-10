import { describe, expect, it, vi } from "vitest";

import { ClientLoader } from "../ClientLoader";

describe("ClientLoader parsed-asset promise recovery", () => {
  it("aborts a stalled response body at the bounded asset deadline", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return {
          ok: true,
          status: 200,
          blob: () =>
            new Promise<Blob>((_resolve, reject) => {
              requestSignal?.addEventListener(
                "abort",
                () => reject(new DOMException("aborted", "AbortError")),
                { once: true },
              );
            }),
        } as Response;
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const loader = Object.create(ClientLoader.prototype) as ClientLoader;
    Object.assign(loader, { assetFetchTimeoutMs: 5 });
    const fetchAssetBlob = (
      loader as unknown as {
        fetchAssetBlob: (url: string) => Promise<Blob>;
      }
    ).fetchAssetBlob.bind(loader);

    try {
      await expect(
        fetchAssetBlob("https://assets.example/contestant_lod1.vrm"),
      ).rejects.toThrow(
        "Asset fetch timed out after 5ms: https://assets.example/contestant_lod1.vrm",
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
  });

  it("deduplicates concurrent failures and retries with a fresh load", async () => {
    const firstFailure = new Error("first transport failure");
    const secondFailure = new Error("second transport failure");
    const loadFile = vi
      .fn()
      .mockRejectedValueOnce(firstFailure)
      .mockRejectedValueOnce(secondFailure);
    const clearCachedFile = vi.fn().mockResolvedValue(undefined);
    const loader = Object.create(ClientLoader.prototype) as ClientLoader;
    Object.assign(loader, {
      world: { resolveURL: (url: string) => url },
      promises: new Map(),
      loadFile,
      clearCachedFile,
    });

    const first = loader.load("avatar", "/avatars/contestant_lod1.vrm");
    const duplicate = loader.load("avatar", "/avatars/contestant_lod1.vrm");
    const firstResults = await Promise.allSettled([first, duplicate]);

    expect(loadFile).toHaveBeenCalledOnce();
    expect(firstResults).toEqual([
      { status: "rejected", reason: firstFailure },
      { status: "rejected", reason: firstFailure },
    ]);
    expect(loader.promises.has("avatar//avatars/contestant_lod1.vrm")).toBe(
      false,
    );

    await expect(
      loader.load("avatar", "/avatars/contestant_lod1.vrm"),
    ).rejects.toBe(secondFailure);
    expect(loadFile).toHaveBeenCalledTimes(2);
    expect(clearCachedFile).toHaveBeenCalledTimes(2);
    expect(loader.promises.has("avatar//avatars/contestant_lod1.vrm")).toBe(
      false,
    );
  });

  it("purges a successfully fetched corrupt avatar before retrying", async () => {
    const firstParseFailure = new Error("truncated GLB");
    const secondParseFailure = new Error("still truncated GLB");
    const corruptFile = new File(
      [new Uint8Array([0x67, 0x6c, 0x54])],
      "bad.vrm",
      {
        type: "model/gltf-binary",
      },
    );
    const loadFile = vi.fn().mockResolvedValue(corruptFile);
    const parseAsync = vi
      .fn()
      .mockRejectedValueOnce(firstParseFailure)
      .mockRejectedValueOnce(secondParseFailure);
    const clearCachedFile = vi.fn().mockResolvedValue(undefined);
    const loader = Object.create(ClientLoader.prototype) as ClientLoader;
    Object.assign(loader, {
      world: { resolveURL: (url: string) => url },
      promises: new Map(),
      loadFile,
      gltfLoader: { parseAsync },
      clearCachedFile,
    });

    const first = loader.load("avatar", "/avatars/contestant_lod1.vrm");
    const duplicate = loader.load("avatar", "/avatars/contestant_lod1.vrm");
    const firstResults = await Promise.allSettled([first, duplicate]);

    expect(firstResults).toEqual([
      { status: "rejected", reason: firstParseFailure },
      { status: "rejected", reason: firstParseFailure },
    ]);
    expect(loadFile).toHaveBeenCalledOnce();
    expect(parseAsync).toHaveBeenCalledOnce();
    expect(clearCachedFile).toHaveBeenCalledOnce();

    await expect(
      loader.load("avatar", "/avatars/contestant_lod1.vrm"),
    ).rejects.toBe(secondParseFailure);
    expect(loadFile).toHaveBeenCalledTimes(2);
    expect(parseAsync).toHaveBeenCalledTimes(2);
    expect(clearCachedFile).toHaveBeenCalledTimes(2);
  });
});
