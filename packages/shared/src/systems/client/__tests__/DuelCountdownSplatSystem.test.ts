import { describe, expect, it, vi } from "vitest";

import THREE from "../../../extras/three/three";
import { DuelCountdownSplatSystem } from "../DuelCountdownSplatSystem";

type CountdownInternals = {
  splatPool: Array<{
    material: THREE.SpriteMaterial;
    sprite: THREE.Sprite;
    active: boolean;
  }>;
  countTextures: Map<number, THREE.CanvasTexture>;
  initPool: () => void;
  prewarmStreamingCountdownPool: () => Promise<void>;
};

describe("DuelCountdownSplatSystem stream warm-up", () => {
  it("precompiles both active pool sprites against every countdown texture", async () => {
    const observedTextures: Array<THREE.Texture | null> = [];
    const graphics = {
      precompileObject: vi.fn(async (sprite: THREE.Object3D) => {
        observedTextures.push((sprite as THREE.Sprite).material.map);
      }),
    };
    const system = new DuelCountdownSplatSystem({
      isClient: true,
      graphics,
    } as never);
    const internals = system as unknown as CountdownInternals;
    const textures = new Map(
      [0, 1, 2, 3].map((count) => [count, new THREE.CanvasTexture()]),
    );
    const pool = Array.from({ length: 6 }, () => {
      const material = new THREE.SpriteMaterial();
      return { material, sprite: new THREE.Sprite(material), active: false };
    });
    internals.countTextures = textures;
    internals.splatPool = pool;
    internals.initPool = vi.fn();

    await internals.prewarmStreamingCountdownPool();

    expect(internals.initPool).toHaveBeenCalledOnce();
    expect(graphics.precompileObject).toHaveBeenCalledTimes(8);
    expect(observedTextures).toEqual([
      textures.get(3),
      textures.get(2),
      textures.get(1),
      textures.get(0),
      textures.get(3),
      textures.get(2),
      textures.get(1),
      textures.get(0),
    ]);
    expect(pool.slice(2).every((item) => item.material.map === null)).toBe(
      true,
    );
  });
});
