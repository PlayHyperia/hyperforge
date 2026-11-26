import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import THREE from "../../../../extras/three/three";
import { Fn, float, uniform, vec3, vec4 } from "three/tsl";
import type Node from "three/src/nodes/core/Node.js";
import {
  createGrassClumpFrameValues,
  GrassClumpFrameCache,
  GRASS_CLUMP_FRAME_LIMITS,
  readGrassClumpFrame,
} from "../GrassClumpFrameCache";

function fixture(count = 3) {
  const player = uniform(new THREE.Vector3(385, 0, 374));
  const speed = uniform(1.8);
  const cache = new GrassClumpFrameCache(player, speed, 112, 140);
  const geometry = new THREE.BufferGeometry();
  const offsets = new THREE.InstancedBufferAttribute(
    new Float32Array(count * 3),
    3,
  );
  geometry.setAttribute("instanceOffset", offsets);
  const material = new THREE.MeshSSSNodeMaterial();
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  return {
    player,
    speed,
    cache,
    geometry,
    offsets,
    material,
    mesh,
    dispose() {
      cache.dispose();
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}

/** Actual installed Three arithmetic, not a substitute renderer/GPU. */
function evaluate(node: Node): number[] {
  const get = (key: string): unknown => Reflect.get(node, key);
  const child = (key: string): number[] => {
    const n = get(key);
    if (!(n instanceof THREE.Node))
      throw new Error(`Missing ${key}:${node.type}`);
    return evaluate(n);
  };
  const value = get("value");
  if (typeof value === "number") return [value];
  if (value instanceof THREE.Vector3) return value.toArray();
  if (node.type === "VarNode" || node.type === "ConvertNode")
    return child("node");
  if (node.type === "SplitNode")
    return [...String(get("components"))].map(
      (c) => child("node")["xyzw".indexOf(c)],
    );
  if (node.type === "JoinNode") {
    const children = get("nodes");
    if (!Array.isArray(children)) throw new Error("Missing joined values");
    return children.flatMap((n: unknown) => {
      if (!(n instanceof THREE.Node)) throw new Error("Invalid joined node");
      return evaluate(n);
    });
  }
  const a = child("aNode");
  if (node.type === "OperatorNode") {
    const b = child("bNode");
    return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => {
      const x = a[i % a.length],
        y = b[i % b.length];
      switch (get("op")) {
        case "+":
          return x + y;
        case "-":
          return x - y;
        case "*":
          return x * y;
        default:
          throw new Error(`Unexpected operator ${String(get("op"))}`);
      }
    });
  }
  if (node.type === "MathNode") {
    if (get("method") === "sin") return a.map(Math.sin);
    const b = child("bNode");
    if (get("method") === "dot")
      return [a.reduce((sum, x, i) => sum + x * b[i], 0)];
    if (get("method") === "pow")
      return a.map((x, i) => Math.pow(x, b[i % b.length]));
    const c = child("cNode");
    if (get("method") === "clamp")
      return a.map((x, i) =>
        Math.max(b[i % b.length], Math.min(c[i % c.length], x)),
      );
    if (get("method") === "smoothstep") {
      const t = Math.max(0, Math.min(1, (c[0] - a[0]) / (b[0] - a[0])));
      return [t * t * (3 - 2 * t)];
    }
  }
  throw new Error(`Unexpected real arithmetic ${node.type}`);
}

function stageGraph(
  f: ReturnType<typeof fixture>,
  stage: "compute" | "vertex",
  owned = true,
) {
  const clone = f.material.clone();
  try {
    const mesh = owned
      ? f.mesh
      : new THREE.InstancedMesh(f.geometry, clone, f.mesh.count);
    const builder = Reflect.construct(THREE.NodeBuilder, [mesh, null, null]);
    const root =
      stage === "compute"
        ? f.cache.compute
        : Fn(() =>
            readGrassClumpFrame(() =>
              createGrassClumpFrameValues(
                vec3(10, 0, 12),
                float(2),
                f.speed,
                f.player,
                float(112),
                float(140),
              ),
            ),
          )();
    const nodes = new Set<Node>();
    const visit = (node: Node) => {
      if (nodes.has(node)) return;
      nodes.add(node);
      const isCall = Reflect.get(node, "isShaderCallNodeInternal") === true;
      if (isCall || typeof Reflect.get(node, "jsFunc") === "function") {
        const call = isCall
          ? node
          : Reflect.apply(Reflect.get(node, "call"), node, []);
        const expand: unknown = Reflect.get(call, "getOutputNode");
        if (typeof expand !== "function")
          throw new Error("Missing real shader expansion");
        const output: unknown = expand.call(call, builder);
        if (!(output instanceof THREE.Node))
          throw new Error("Missing real shader output");
        visit(output);
        return;
      }
      for (const child of node.getChildren()) visit(child);
    };
    visit(root);
    return [...nodes];
  } finally {
    clone.dispose();
  }
}

describe("bounded clump-frame dynamics (real CPU/TSL objects, not native qualification)", () => {
  it.each([0, 1, 23.9, 8192])(
    "retains both raw wind waves and exact fade arithmetic at time %s",
    (clock) => {
      for (const distance of [
        0, 111.999, 112, 112.001, 126, 139.999, 140, 140.001, 1000,
      ]) {
        const x = 385 + distance,
          z = 374;
        const result = evaluate(
          createGrassClumpFrameValues(
            vec3(x, 999, z),
            float(clock),
            float(1.8),
            vec3(385, -99, 374),
            float(112),
            float(140),
          ),
        );
        const t = Math.max(
          0,
          Math.min(1, (Math.sqrt(distance * distance) - 112) / 28),
        );
        expect(result[0]).toBe(Math.sin(clock * 1.8 + x * 0.35 + z * 0.12));
        expect(result[1]).toBe(
          Math.sin(clock * 1.8 * 0.67 + x * 0.18 + z * 0.28 + 2),
        );
        expect(result[2]).toBeCloseTo(1 - t * t * (3 - 2 * t), 13);
        expect(result[3]).toBe(0);
      }
    },
  );

  it("allocates fixed float32 unfiltered ownership, no borrowed source buffers", () => {
    const f = fixture();
    try {
      expect(f.cache.output.type).toBe(THREE.FloatType);
      expect(f.cache.output.minFilter).toBe(THREE.NearestFilter);
      expect(f.cache.output.generateMipmaps).toBe(false);
      expect(f.cache.output.colorSpace).toBe(THREE.NoColorSpace);
      expect(Reflect.get(f.cache.output, "mipmapsAutoUpdate")).toBe(false);
      expect(f.cache.getReceipt()).toMatchObject({
        capacity: 262144,
        outputBytes: 4194304,
        inputBytes: 4202496,
        prepared: false,
        submissions: 0,
      });
      const attrs = Object.keys(f.geometry.attributes);
      expect(f.cache.register(f.mesh)).toBe(true);
      expect(Object.keys(f.geometry.attributes)).toEqual(attrs);
      expect(f.cache.getReceipt()).toMatchObject({
        owners: 1,
        clumps: 3,
        highWater: 3,
      });
    } finally {
      f.dispose();
    }
  });

  it("builds one bounded real compute graph with exact world matrix multiply and frame token store", () => {
    const f = fixture();
    try {
      const nodes = stageGraph(f, "compute");
      const stores = nodes.filter(
        (n) => n.type === "StorageTextureNode" && Reflect.get(n, "storeNode"),
      );
      expect(stores).toHaveLength(1);
      expect(Reflect.get(stores[0], "value")).toBe(f.cache.output);
      expect(
        nodes.filter(
          (n) =>
            n.type === "TextureNode" && Reflect.get(n, "sampler") === false,
        ),
      ).toHaveLength(5);
      expect(
        nodes.filter(
          (n) => n.type === "MathNode" && Reflect.get(n, "method") === "sin",
        ),
      ).toHaveLength(2);
      expect(
        nodes.filter(
          (n) =>
            n.type === "MathNode" && Reflect.get(n, "method") === "smoothstep",
        ),
      ).toHaveLength(1);
      expect(nodes).toContain(f.cache.generation);
      expect(f.cache.compute.count).toBe(262144);
    } finally {
      f.dispose();
    }
  });

  it("reads only a registered material, validates output generation, then uses one conditional live fallback", () => {
    const f = fixture();
    try {
      expect(f.cache.register(f.mesh)).toBe(true);
      const owned = stageGraph(f, "vertex");
      expect(
        owned.filter(
          (n) =>
            n.type === "TextureNode" &&
            Reflect.get(n, "value") === f.cache.output,
        ),
      ).toHaveLength(1);
      expect(
        owned.filter(
          (n) =>
            n.type === "OperatorNode" &&
            Reflect.get(n, "op") === "==" &&
            Reflect.get(n, "bNode") === f.cache.generation,
        ),
      ).toHaveLength(1);
      expect(
        owned.filter(
          (n) => n.type === "MathNode" && Reflect.get(n, "method") === "sin",
        ),
      ).toHaveLength(2);
      expect(owned.filter((n) => n.type === "ConditionalNode")).toHaveLength(3);
      expect(
        stageGraph(f, "vertex", false).some((n) => n.type === "TextureNode"),
      ).toBe(false);
      f.cache.retire(f.mesh);
      expect(
        stageGraph(f, "vertex").some((n) => n.type === "TextureNode"),
      ).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it("coalesces retired ranges and safely reuses slots without reusing retired material ownership", () => {
    const f = fixture(4096),
      g = fixture(4096);
    try {
      expect(f.cache.register(f.mesh)).toBe(true);
      expect(f.cache.register(g.mesh)).toBe(true);
      expect(f.cache.getReceipt()).toMatchObject({
        owners: 2,
        highWater: 8192,
      });
      f.cache.retire(f.mesh);
      expect(f.cache.register(f.mesh)).toBe(true);
      expect(f.cache.getReceipt()).toMatchObject({
        owners: 2,
        highWater: 8192,
      });
      f.cache.retire(g.mesh);
      f.cache.retire(f.mesh);
      expect(f.cache.getReceipt()).toMatchObject({
        owners: 0,
        clumps: 0,
        highWater: 0,
      });
      expect(f.cache.register(g.mesh)).toBe(true);
      expect(f.cache.getReceipt().highWater).toBe(4096);
    } finally {
      f.dispose();
      g.dispose();
    }
  });

  it("supplies each lease address through an immutable uint uniform, not a per-chunk shader literal", () => {
    const f = fixture(3),
      g = fixture(5);
    try {
      expect(f.cache.register(f.mesh)).toBe(true);
      expect(f.cache.register(g.mesh)).toBe(true);
      const graph = stageGraph(g, "vertex");
      const offsets = graph.filter(
        (node) =>
          node.type === "UniformNode" &&
          Reflect.get(node, "nodeType") === "uint" &&
          Reflect.get(node, "value") === 3,
      );
      expect(offsets).toHaveLength(1);
      expect(
        Object.getOwnPropertyDescriptor(offsets[0], "value"),
      ).toMatchObject({ writable: false, configurable: false });
      expect(
        graph.some(
          (node) =>
            node.type === "ConstNode" && Reflect.get(node, "value") === 3,
        ),
      ).toBe(false);
    } finally {
      f.dispose();
      g.dispose();
    }
  });

  it("changes actual NodeMaterial shader identity across registration, retirement and reuse, not frame tokens", () => {
    const f = fixture();
    try {
      const original = f.material.customProgramCacheKey;
      const baseline = f.material.customProgramCacheKey();
      expect(Object.hasOwn(f.material, "customProgramCacheKey")).toBe(false);
      expect(f.cache.register(f.mesh)).toBe(true);
      const first = f.material.customProgramCacheKey();
      expect(first).not.toBe(baseline);
      expect(first.startsWith(`${baseline}|grass-clump-frame:`)).toBe(true);
      f.cache.generation.value++;
      expect(f.material.customProgramCacheKey()).toBe(first);
      f.cache.retire(f.mesh);
      expect(Object.hasOwn(f.material, "customProgramCacheKey")).toBe(false);
      expect(f.material.customProgramCacheKey).toBe(original);
      expect(f.material.customProgramCacheKey()).toBe(baseline);
      expect(
        stageGraph(f, "vertex").some((n) => n.type === "TextureNode"),
      ).toBe(false);
      expect(f.cache.register(f.mesh)).toBe(true);
      const second = f.material.customProgramCacheKey();
      expect(second).not.toBe(first);
      expect(second).not.toBe(baseline);
      f.cache.dispose();
      expect(f.material.customProgramCacheKey()).toBe(baseline);
      expect(Object.hasOwn(f.material, "customProgramCacheKey")).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it("delegates owned shader keys with their actual receiver and restores exact descriptors without replacing a foreign writer", () => {
    const f = fixture();
    try {
      const original = f.material.customProgramCacheKey;
      const descriptor = {
        value: function (this: THREE.Material) {
          return `${original.call(this)}:authored:${this.uuid}`;
        },
        configurable: true,
        writable: false,
        enumerable: true,
      };
      Object.defineProperty(f.material, "customProgramCacheKey", descriptor);
      const baseline = f.material.customProgramCacheKey();
      expect(f.cache.register(f.mesh)).toBe(true);
      expect(
        f.material.customProgramCacheKey().startsWith(`${baseline}|`),
      ).toBe(true);
      f.cache.retire(f.mesh);
      expect(
        Object.getOwnPropertyDescriptor(f.material, "customProgramCacheKey"),
      ).toEqual(descriptor);
      expect(f.cache.register(f.mesh)).toBe(true);
      const foreign = () => "foreign-material-owner";
      Object.defineProperty(f.material, "customProgramCacheKey", {
        ...descriptor,
        value: foreign,
      });
      f.cache.retire(f.mesh);
      expect(f.material.customProgramCacheKey).toBe(foreign);
      expect(
        Object.getOwnPropertyDescriptor(f.material, "customProgramCacheKey"),
      ).toEqual({ ...descriptor, value: foreign });
    } finally {
      f.dispose();
    }
  });

  it("does not lease shader identities that cannot be restored", () => {
    const f = fixture();
    try {
      Object.defineProperty(f.material, "customProgramCacheKey", {
        value: f.material.customProgramCacheKey,
        configurable: false,
        writable: true,
      });
      const baseline = f.material.customProgramCacheKey();
      expect(f.cache.register(f.mesh)).toBe(false);
      expect(f.cache.getReceipt().owners).toBe(0);
      expect(f.material.customProgramCacheKey()).toBe(baseline);
    } finally {
      f.dispose();
    }
  });

  it("invalidates delegating foreign keys and retains opaque foreign bindings until real material disposal", () => {
    const f = fixture();
    let textureDisposals = 0;
    f.cache.output.addEventListener("dispose", () => textureDisposals++);
    try {
      const baseline = f.material.customProgramCacheKey();
      expect(f.cache.register(f.mesh)).toBe(true);
      const leased = f.material.customProgramCacheKey;
      const foreign = function (this: THREE.Material) {
        return `${leased.call(this)}:foreign-wrapper`;
      };
      f.material.customProgramCacheKey = foreign;
      const active = f.material.customProgramCacheKey();
      f.cache.retire(f.mesh);
      expect(f.material.customProgramCacheKey).toBe(foreign);
      expect(f.material.customProgramCacheKey()).toBe(
        `${baseline}:foreign-wrapper`,
      );
      expect(f.material.customProgramCacheKey()).not.toBe(active);
      expect(f.cache.getReceipt().retainedMaterialBindings).toBe(1);
      expect(f.cache.register(f.mesh)).toBe(false);
      f.cache.dispose();
      expect(f.cache.getReceipt().disposed).toBe(false);
      expect(textureDisposals).toBe(0);
      f.material.dispose();
      expect(f.cache.getReceipt()).toMatchObject({
        disposed: true,
        retainedMaterialBindings: 0,
      });
      expect(textureDisposals).toBe(1);
    } finally {
      f.dispose();
    }
    expect(textureDisposals).toBe(1);
  });

  it("does not free stale bindings behind a foreign constant key or miss disposal-triggered retirement", () => {
    for (const materialDisposesFirst of [false, true]) {
      const f = fixture();
      let textureDisposals = 0;
      f.cache.output.addEventListener("dispose", () => textureDisposals++);
      try {
        expect(f.cache.register(f.mesh)).toBe(true);
        const cachedKey = f.material.customProgramCacheKey();
        const foreign = () => cachedKey;
        f.material.customProgramCacheKey = foreign;
        if (materialDisposesFirst) f.material.dispose();
        f.cache.dispose();
        expect(textureDisposals).toBe(materialDisposesFirst ? 1 : 0);
        expect(f.material.customProgramCacheKey).toBe(foreign);
        f.material.dispose();
        expect(textureDisposals).toBe(1);
        expect(f.cache.getReceipt()).toMatchObject({
          disposed: true,
          retainedMaterialBindings: 0,
        });
      } finally {
        f.dispose();
      }
    }
  });

  it("rejects excess owner sizes and duplicate material owners without changing placement", () => {
    const f = fixture(GRASS_CLUMP_FRAME_LIMITS.ownerClumps + 1),
      g = fixture(2);
    try {
      expect(f.cache.register(f.mesh)).toBe(false);
      expect(f.cache.register(g.mesh)).toBe(true);
      const other = new THREE.InstancedMesh(g.geometry, g.material, 2);
      expect(f.cache.register(other)).toBe(false);
      expect(f.cache.getReceipt()).toMatchObject({ owners: 1, clumps: 2 });
      other.dispose();
    } finally {
      f.dispose();
      g.dispose();
    }
  });

  it("caps the aggregate texel budget and reclaims exactly one retired range", () => {
    const f = fixture(4096);
    const meshes: THREE.InstancedMesh[] = [];
    try {
      for (let i = 0; i < 65; i++) {
        const mesh = new THREE.InstancedMesh(
          f.geometry.clone(),
          f.material.clone(),
          4096,
        );
        meshes.push(mesh);
        expect(f.cache.register(mesh)).toBe(i < 64);
      }
      expect(f.cache.getReceipt()).toMatchObject({
        owners: 64,
        clumps: 262144,
        highWater: 262144,
      });
      const version = meshes[0].material.version;
      f.cache.retire(meshes[0]);
      expect(meshes[0].material.version).toBeGreaterThan(version);
      expect(f.cache.register(meshes[64])).toBe(true);
      expect(f.cache.getReceipt()).toMatchObject({
        owners: 64,
        clumps: 262144,
        highWater: 262144,
      });
    } finally {
      f.cache.dispose();
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh.dispose();
      }
      f.dispose();
    }
  });

  it("bounds metadata slots separately from texels and leaves foreign instances unchanged", () => {
    const f = fixture(2);
    const meshes: THREE.InstancedMesh[] = [];
    try {
      for (let i = 0; i < 129; i++) {
        const mesh = new THREE.InstancedMesh(
          f.geometry.clone(),
          f.material.clone(),
          2,
        );
        meshes.push(mesh);
        expect(f.cache.register(mesh)).toBe(i < 128);
      }
      expect(f.cache.getReceipt()).toMatchObject({ owners: 128, clumps: 256 });
      expect(meshes[128].count).toBe(2);
      const retainedKey = meshes[31].material.customProgramCacheKey();
      meshes[31].material.customProgramCacheKey = () => retainedKey;
      f.cache.retire(meshes[31]);
      expect(f.cache.getReceipt()).toMatchObject({
        owners: 127,
        retainedMaterialBindings: 1,
      });
      expect(f.cache.register(meshes[128])).toBe(false);
      meshes[31].material.dispose();
      expect(f.cache.register(meshes[128])).toBe(true);
      expect(f.cache.getReceipt()).toMatchObject({ owners: 128, clumps: 256 });
    } finally {
      f.cache.dispose();
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh.dispose();
      }
      f.dispose();
    }
  });

  it.each(["material", "geometry", "mesh"] as const)(
    "retires an externally disposed %s without disposing shared cache maps",
    (kind) => {
      const f = fixture();
      let disposed = 0;
      f.cache.output.addEventListener("dispose", () => disposed++);
      try {
        expect(f.cache.register(f.mesh)).toBe(true);
        f[kind].dispose();
        expect(f.cache.getReceipt().owners).toBe(0);
        expect(disposed).toBe(0);
        f.cache.dispose();
        f.cache.dispose();
        expect(disposed).toBe(1);
        expect(f.cache.register(f.mesh)).toBe(false);
      } finally {
        f.dispose();
      }
    },
  );

  it("fails closed with a real uninitialized WebGPU renderer and disposes only its three textures once", async () => {
    const f = fixture();
    const dom = new JSDOM("<canvas></canvas>");
    const canvas = dom.window.document.querySelector("canvas");
    if (!canvas) throw new Error("Missing real canvas");
    const renderer = new THREE.WebGPURenderer({ canvas });
    const counts = [0, 0, 0];
    [f.cache.output, f.cache.input, f.cache.matrices].forEach((texture, i) =>
      texture.addEventListener("dispose", () => counts[i]++),
    );
    try {
      await f.cache.prepare(renderer);
      f.cache.dispatch(renderer);
      expect(f.cache.getReceipt()).toMatchObject({
        failed: true,
        prepared: false,
        submissions: 0,
        generation: 0,
      });
      f.cache.finishFrame();
      f.cache.dispose();
      f.cache.dispose();
      expect(counts).toEqual([1, 1, 1]);
    } finally {
      f.dispose();
      renderer.dispose();
      dom.window.close();
    }
  });
});
