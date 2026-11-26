import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import type { Node, UniformNode } from "three/webgpu";

import THREE from "../../../../extras/three/three";
import { createCompactTerrainColorOperations } from "../CompactTerrainPalette";
import {
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  validateWorldTerrainProfile,
} from "../WorldTerrainProfile";
import {
  MAX_VERTEX_LIGHTS,
  TERRAIN_SHADE,
  TERRAIN_SHADER_CONSTANTS,
  TerrainShadeUniforms,
  createTerrainMaterial,
  updateTerrainVertexLights,
} from "../TerrainShader";

describe("TerrainShader material graph", () => {
  it("keeps raw dirt caching absent by default and admits only the bounded stochastic candidate", () => {
    type Options = NonNullable<Parameters<typeof createTerrainMaterial>[1]>;
    for (const options of [
      { compactDirtSurfaceCache: "dirt-page-v1" },
      { compactPbr: true, compactDirtSurfaceCache: "dirt-page-v1" },
    ] satisfies Options[])
      expect(() => createTerrainMaterial(undefined, options)).toThrow(
        "requires the explicit stochastic compact PBR candidate",
      );
    const invalid: Options = {
      compactPbr: true,
      compactDirtProjection: "stochastic-v1",
    };
    Reflect.set(invalid, "compactDirtSurfaceCache", "unbounded");
    expect(() => createTerrainMaterial(undefined, invalid)).toThrow(
      "requires the explicit stochastic compact PBR candidate",
    );
    const baseline = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactDirtProjection: "stochastic-v1",
    });
    const candidate = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactDirtProjection: "stochastic-v1",
      compactDirtSurfaceCache: "dirt-page-v1",
    });
    try {
      expect(baseline).not.toHaveProperty("compactDirtSurfacePage");
      expect(candidate.compactDirtSurfacePage).toBeDefined();
      expect(
        Object.getOwnPropertyDescriptor(candidate, "compactDirtSurfacePage"),
      ).toMatchObject({ writable: false, configurable: false });
      expect(candidate.compactTerrainSurface?.getReceipt().status).toBe("idle");
      expect(candidate.terrainUniforms.vertexLightColors).toHaveLength(
        MAX_VERTEX_LIGHTS,
      );
      expect(candidate).not.toHaveProperty("compactGroundSampling");
      expect(candidate).not.toHaveProperty("compactRockSampling");
    } finally {
      baseline.dispose();
      candidate.dispose();
    }
  });

  it("admits regional bank evaluation only for a bound compact bank and pins its receipt", () => {
    type Options = NonNullable<Parameters<typeof createTerrainMaterial>[1]>;
    const invalid: Options = { compactPbr: true };
    Reflect.set(invalid, "compactTerrainBankEvaluation", "regional-v2");
    expect(() => createTerrainMaterial(undefined, invalid)).toThrow(
      "Invalid compact terrain bank evaluation",
    );
    expect(() =>
      createTerrainMaterial(undefined, {
        compactTerrainBankEvaluation: "regional-v1",
      }),
    ).toThrow("requires the compact PBR material");
    expect(() =>
      createTerrainMaterial(undefined, {
        compactPbr: true,
        compactTerrainBankEvaluation: "regional-v1",
      }),
    ).toThrow("requires an admitted pond bank field");
    const pond = {
      id: "bank_test_water",
      centerX: 343,
      centerZ: 302,
      radius: 7.5,
      surfaceY: 27.8,
    };
    const bank = createCompactTerrainColorOperations().pondBankField(
      {
        id: "bank_test_floor",
        centerX: 343,
        centerZ: 302,
        width: 22,
        depth: 22,
        height: 26.6,
        blendRadius: 2,
        radialPond: {
          bedRadius: 5,
          bankInnerRadius: 6.5,
          bankOuterRadius: 9,
          bankHeight: 28.08,
          shorelineAmplitude: 0.9,
          bankSectors: [
            {
              bearing: 0.7,
              halfWidth: 0.55,
              innerRadius: 6.4,
              innerHeight: 27.86,
            },
          ],
          bankComposition: {
            schemaVersion: 1,
            sectors: [{ sectorIndex: 0, surface: "cutbank" }],
          },
        },
      },
      pond,
    )!;
    const options: Options = {
      compactPbr: true,
      compactProfile: validateWorldTerrainProfile({
        ...SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
        southernMeadow: {
          schemaVersion: 1,
          minX: 304,
          maxX: 500,
          minZ: 345,
          maxZ: 535,
          featherX: 24,
          featherZ: 24,
          northHeight: 26.8,
          southHeight: 25.3,
          crossFall: 1,
          rollAmplitude: 0.65,
          rollWavelength: 100,
        },
      }),
      compactSurfaceBlend: "height-v1",
      compactPondBlend: "composition-v1",
      compactPond: pond,
      compactPondBankField: bank,
    };
    const baseline = createTerrainMaterial(undefined, options);
    const candidate = createTerrainMaterial(undefined, {
      ...options,
      compactTerrainBankEvaluation: "regional-v1",
    });
    try {
      expect(baseline).not.toHaveProperty("compactTerrainBankEvaluation");
      expect(candidate.compactTerrainBankEvaluation).toBe("regional-v1");
      expect(
        Object.getOwnPropertyDescriptor(
          candidate,
          "compactTerrainBankEvaluation",
        ),
      ).toEqual({
        value: "regional-v1",
        enumerable: true,
        writable: false,
        configurable: false,
      });
      expect(candidate.compactPondBankField).toEqual(
        baseline.compactPondBankField,
      );
      for (const material of [baseline, candidate]) {
        expect(material).not.toHaveProperty("compactGroundSampling");
        expect(material).not.toHaveProperty("compactRockSampling");
        const receipt = material.compactTerrainSurface!.getReceipt();
        expect(receipt).not.toHaveProperty("textureMatrix");
        expect(receipt).not.toHaveProperty("textureEncoding");
        expect(receipt.textures).toHaveLength(7);
      }
    } finally {
      baseline.dispose();
      candidate.dispose();
    }
  });
  it("admits identity terrain texture matrices only explicitly for independent compact materials", () => {
    type Options = NonNullable<Parameters<typeof createTerrainMaterial>[1]>;
    const invalid: Options = { compactPbr: true };
    Reflect.set(invalid, "compactTerrainTextureMatrix", "identity-v2");
    expect(() => createTerrainMaterial(undefined, invalid)).toThrow(
      "Invalid compact terrain texture matrix mode",
    );
    expect(() =>
      createTerrainMaterial(undefined, {
        compactTerrainTextureMatrix: "identity-v1",
      }),
    ).toThrow("requires the compact PBR material");
    const baseline = createTerrainMaterial(undefined, { compactPbr: true });
    const first = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactTerrainTextureMatrix: "identity-v1",
    });
    const second = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactTerrainTextureMatrix: "identity-v1",
    });
    try {
      expect(baseline.compactTerrainSurface!.getReceipt()).not.toHaveProperty(
        "textureMatrix",
      );
      expect(first.compactTerrainSurface!.getReceipt().textureMatrix).toBe(
        "identity-v1",
      );
      const a = first.compactTerrainSurface!.getNode(
        "grass",
        "albedo-roughness",
      );
      const b = second.compactTerrainSurface!.getNode(
        "grass",
        "albedo-roughness",
      );
      expect(a).not.toBe(b);
      expect(a.value).not.toBe(b.value);
      first.dispose();
      expect(second.compactTerrainSurface!.getReceipt().status).toBe("idle");
    } finally {
      baseline.dispose();
      first.dispose();
      second.dispose();
    }
  });
  it("requires explicit admitted rock sampling before deferring ground appearance", () => {
    type Options = NonNullable<Parameters<typeof createTerrainMaterial>[1]>;
    const invalid: Options = {};
    Reflect.set(invalid, "compactGroundSampling", "epsilon-v1");
    expect(() => createTerrainMaterial(undefined, invalid)).toThrow(
      "Invalid compact ground sampling",
    );
    for (const compactRockSampling of [undefined, "disabled"] as const) {
      const missing: Options = { compactGroundSampling: "exact-zero-v1" };
      Reflect.set(missing, "compactRockSampling", compactRockSampling);
      expect(() => createTerrainMaterial(undefined, missing)).toThrow(
        "Exact-zero ground sampling requires exact-zero rock sampling",
      );
    }
    // The new opt-in does not bypass the rock selector's surface admission.
    expect(() =>
      createTerrainMaterial(undefined, {
        compactGroundSampling: "exact-zero-v1",
        compactRockSampling: "exact-zero-v1",
      }),
    ).toThrow(/Exact-zero rock sampling requires/);
    expect(() =>
      createTerrainMaterial(undefined, {
        compactGroundSampling: "exact-zero-v1",
        compactRockSampling: "exact-zero-v1",
        compactPbr: true,
        compactDirtProjection: "stochastic-v1",
        compactRockProjection: "stochastic-v1",
        compactSurfaceBlend: "height-v1",
        compactPondBlend: "composition-v1",
      }),
    ).toThrow("Pond blending requires an admitted compact pond");
  });

  it("rejects unsupported deferred rock sampling before constructing textures", () => {
    type Options = NonNullable<Parameters<typeof createTerrainMaterial>[1]>;
    const dependencies: Options = {
      compactPbr: true,
      compactDirtProjection: "stochastic-v1",
      compactRockProjection: "stochastic-v1",
      compactSurfaceBlend: "height-v1",
      compactPondBlend: "composition-v1",
      compactRockSampling: "exact-zero-v1",
    };
    const invalid: Options = { ...dependencies };
    Reflect.set(invalid, "compactRockSampling", "epsilon-v1");
    expect(() => createTerrainMaterial(undefined, invalid)).toThrow(
      "Invalid compact rock sampling",
    );
    for (const dependency of [
      "compactDirtProjection",
      "compactRockProjection",
      "compactSurfaceBlend",
      "compactPondBlend",
    ] as const) {
      const missing = { ...dependencies };
      delete missing[dependency];
      expect(() => createTerrainMaterial(undefined, missing)).toThrow(
        /Exact-zero rock sampling requires/,
      );
    }
    expect(() =>
      createTerrainMaterial(undefined, {
        compactRockSampling: "exact-zero-v1",
      }),
    ).toThrow(/Exact-zero rock sampling requires/);
    expect(() =>
      createTerrainMaterial(undefined, {
        ...dependencies,
        compactCoastBlend: "cavity-v1",
      }),
    ).toThrow(/Exact-zero rock sampling requires/);
    // A valid sampling selector does not waive the existing pond admission.
    expect(() => createTerrainMaterial(undefined, dependencies)).toThrow(
      "Pond blending requires an admitted compact pond",
    );
  });

  it("preserves the original palette and shares only an explicitly supplied owner", () => {
    const first = createTerrainMaterial();
    const second = createTerrainMaterial();
    const explicit = new TerrainShadeUniforms();
    const shared = createTerrainMaterial(explicit);
    for (const material of [first, second, shared])
      for (const key of ["compactRockSampling", "compactGroundSampling"])
        expect(Object.prototype.hasOwnProperty.call(material, key)).toBe(false);
    expect(first.terrainUniforms.shade.tint.value.toArray()).toEqual([
      ...TERRAIN_SHADE.TINT_COLOR,
    ]);
    expect(first.terrainUniforms.shade.strength.value).toBe(
      TERRAIN_SHADE.STRENGTH,
    );
    expect(first.terrainUniforms.shade).not.toBe(second.terrainUniforms.shade);
    expect(first.terrainUniforms.shade.tint.value).not.toBe(
      second.terrainUniforms.shade.tint.value,
    );
    expect(shared.terrainUniforms.shade).toBe(explicit);
    const originalVersion = shared.version;
    explicit.tint.value.setRGB(1, 1, 1);
    explicit.strength.value = 0;
    expect(shared.version).toBe(originalVersion);
    expect(first.terrainUniforms.shade.tint.value.toArray()).toEqual([
      ...TERRAIN_SHADE.TINT_COLOR,
    ]);
    first.dispose();
    second.dispose();
    shared.dispose();
  });
  it("constructs typed runtime uniforms and updates vertex lights", () => {
    const material = createTerrainMaterial();
    if (!(material instanceof THREE.MeshStandardNodeMaterial))
      throw new Error("Expected actual terrain MeshStandardNodeMaterial");
    const { terrainUniforms } = material;
    const light = {
      position: new THREE.Vector3(2, 3, 4),
      color: new THREE.Color(0xffcc88),
      intensity: 1.5,
      range: 18,
    };

    expect(material.colorNode).toBeTruthy();
    expect(material.outputNode).toBeTruthy();
    expect(terrainUniforms.sunPosition.value).toBeInstanceOf(THREE.Vector3);
    expect(terrainUniforms.sunDirection.value).toBeInstanceOf(THREE.Vector3);
    expect(terrainUniforms.time.value).toBe(0);
    expect(terrainUniforms.vertexLightPositions).toHaveLength(
      MAX_VERTEX_LIGHTS,
    );
    expect(terrainUniforms.vertexLightColors).toHaveLength(MAX_VERTEX_LIGHTS);
    expect(terrainUniforms.vertexLightParams).toHaveLength(MAX_VERTEX_LIGHTS);

    updateTerrainVertexLights(terrainUniforms, [light]);
    expect(terrainUniforms.vertexLightPositions[0].value).toEqual(
      light.position,
    );
    expect(terrainUniforms.vertexLightColors[0].value).toEqual(
      new THREE.Vector3(light.color.r, light.color.g, light.color.b),
    );
    expect(terrainUniforms.vertexLightParams[0].value).toEqual(
      new THREE.Vector2(light.intensity, light.range),
    );
    expect(terrainUniforms.vertexLightParams[1].value).toEqual(
      new THREE.Vector2(0, 1),
    );

    material.dispose();
  });
});

// Exercise installed Three binding/scheduling objects without initializing a
// renderer, replacing its methods, or claiming compiled/native GPU coverage.
type TerrainMaterial = ReturnType<typeof createTerrainMaterial>;
type TerrainLightNode =
  | TerrainMaterial["terrainUniforms"]["vertexLightPositions"][number]
  | TerrainMaterial["terrainUniforms"]["vertexLightParams"][number];
type UniformBuffer = {
  groupNode: TerrainLightNode["groupNode"];
  uniforms: Array<{
    nodeUniform: { node: TerrainLightNode };
    offset: number;
    itemSize: number;
  }>;
  buffer: Float32Array;
  update(): boolean;
  clearUpdateRanges(): void;
};
type BindingGroup = { name: string; bindings: UniformBuffer[] };
type BindingBuilder = THREE.WGSLNodeBuilder & {
  setShaderStage(stage: "vertex" | "fragment"): void;
  getUniformFromNode(
    node: TerrainLightNode,
    type: string,
    stage: "vertex" | "fragment",
  ): unknown;
  getBindings(): BindingGroup[];
};

function graph(root: Node): Set<Node> {
  const visited = new Set<Node>();
  function visit(node: Node) {
    if (visited.has(node)) return;
    visited.add(node);
    for (const child of node.getChildren()) visit(child);
  }
  visit(root);
  return visited;
}

function terrainLightNodes(material: TerrainMaterial): TerrainLightNode[] {
  const u = material.terrainUniforms;
  return [
    ...u.vertexLightPositions,
    ...u.vertexLightColors,
    ...u.vertexLightParams,
  ];
}

async function bindingFixture() {
  // These installed private classes have no published declarations. The narrow
  // types describe their real instances; no substitute implementations exist.
  const internal = "three/src/renderers/common/";
  const { default: NodeManager } = (await import(
    `${internal}nodes/NodeManager.js`
  )) as {
    default: new (
      renderer: THREE.WebGPURenderer,
      backend: unknown,
    ) => { updateGroup(binding: UniformBuffer): boolean; dispose(): void };
  };
  const { default: RenderContext } = (await import(
    `${internal}RenderContext.js`
  )) as { default: new () => object };
  const { default: NodeBuilderState } = (await import(
    `${internal}nodes/NodeBuilderState.js`
  )) as {
    default: new (
      vertex: string,
      fragment: string,
      compute: string,
      attributes: [],
      bindings: BindingGroup[],
      updates: [],
      before: [],
      after: [],
      observer: null,
      clipping: boolean,
    ) => { createBindings(): BindingGroup[] };
  };
  const dom = new JSDOM("<!doctype html><canvas></canvas>");
  const renderer = new THREE.WebGPURenderer({
    canvas: dom.window.document.querySelector("canvas")!,
  });
  const manager = new NodeManager(renderer, renderer.backend);
  const geometry = new THREE.BufferGeometry();
  const primary = new RenderContext();
  const reflection = new RenderContext();
  function bindings(
    material: TerrainMaterial,
    nodes = terrainLightNodes(material),
    context = primary,
    stages: Array<"vertex" | "fragment"> = ["fragment"],
  ) {
    const previous = Reflect.get(renderer, "_currentRenderContext");
    Reflect.set(renderer, "_currentRenderContext", context);
    try {
      const builder = new THREE.WGSLNodeBuilder(
        new THREE.Mesh(geometry, material),
        renderer,
      ) as BindingBuilder;
      for (const stage of stages) {
        builder.setShaderStage(stage);
        for (const node of nodes) {
          const type = node.getNodeType(builder);
          // The terrain light/albedo terms are fragment inputs. The explicit
          // dual-stage case below tests buffer sharing, not their actual use.
          builder.getUniformFromNode(node, type, stage);
        }
      }
      return builder.getBindings();
    } finally {
      Reflect.set(renderer, "_currentRenderContext", previous);
    }
  }
  function renderBuffer(material: TerrainMaterial, context = primary) {
    const groups = bindings(material, terrainLightNodes(material), context);
    const group = groups.find((entry) => entry.name === "render");
    expect(group).toBeDefined();
    expect(group!.bindings).toHaveLength(1);
    return group!.bindings[0];
  }
  return {
    manager,
    reflection,
    bindings,
    renderBuffer,
    instanceBindings(groups: BindingGroup[]) {
      return new NodeBuilderState(
        "",
        "",
        "",
        [],
        groups,
        [],
        [],
        [],
        null,
        false,
      ).createBindings();
    },
    async dispose() {
      manager.dispose();
      geometry.dispose();
      await renderer.dispose();
      dom.window.close();
    },
  };
}

describe("terrain render-scoped uniform ownership", () => {
  it("groups exactly the 24 light nodes and four local controls, not shared palette or stock state", () => {
    const material = createTerrainMaterial(undefined, {
      compactPbr: true,
      compactPond: {
        id: "uniform-test",
        centerX: 10,
        centerZ: 20,
        radius: 8,
        surfaceY: 3,
      },
    });
    try {
      if (
        !(material instanceof THREE.MeshStandardNodeMaterial) ||
        !material.colorNode
      )
        throw new Error("Expected actual terrain graph");
      // The repository's ambient material extension declares colorNode unknown.
      // The actual node material and non-null graph are checked above.
      const colorNode = material.colorNode as Node;
      expect(material.positionNode).toBeNull();
      for (const node of terrainLightNodes(material))
        expect(graph(colorNode).has(node)).toBe(true);
      const noise = [...graph(colorNode)].filter(
        (node) =>
          Reflect.get(node, "isUniformNode") === true &&
          Reflect.get(node, "value") === TERRAIN_SHADER_CONSTANTS.NOISE_SCALE,
      );
      expect(noise).toHaveLength(1);
      const admitted = [
        ...terrainLightNodes(material),
        material.terrainUniforms.fogEnabled,
        material.terrainUniforms.surfaceDetailStrength,
        material.compactPondMaterial!.parameters,
        noise[0] as UniformNode<"float", number>,
      ];
      expect(new Set(admitted).size).toBe(28);
      for (const node of admitted)
        expect(node.groupNode).toBe(THREE.TSL.renderGroup);
      for (const node of [
        material.terrainUniforms.shade.tint,
        material.terrainUniforms.shade.strength,
        material.terrainUniforms.sunPosition,
        material.terrainUniforms.sunDirection,
        material.terrainUniforms.dayIntensity,
        material.terrainUniforms.time,
      ])
        expect(node.groupNode).toBe(THREE.TSL.objectGroup);
      for (const node of graph(colorNode)) {
        if (Reflect.get(node, "isTextureNode") === true)
          expect(Reflect.get(node, "groupNode")).toBe(THREE.TSL.objectGroup);
      }
    } finally {
      material.dispose();
    }
  });

  it("shares actual chunk bindings only for the same node owner and render context", async () => {
    const f = await bindingFixture(),
      a = createTerrainMaterial(),
      b = createTerrainMaterial();
    try {
      const first = f.bindings(a),
        second = f.bindings(a),
        other = f.bindings(b);
      expect(first[0].name).toBe("render");
      expect(first[0]).toBe(second[0]);
      expect(first[0]).not.toBe(other[0]);
      expect(first[0]).not.toBe(
        f.bindings(a, terrainLightNodes(a), f.reflection)[0],
      );
      expect(
        new Set(first[0].bindings[0].uniforms.map((u) => u.nodeUniform.node)),
      ).toEqual(new Set(terrainLightNodes(a)));
      expect(first[0].bindings[0].uniforms).toHaveLength(24);
      const dualStage = f.bindings(a, terrainLightNodes(a), undefined, [
        "vertex",
        "fragment",
      ]);
      expect(dualStage).toHaveLength(1);
      expect(dualStage[0].bindings).toHaveLength(1);
      // Installed r186 allocates distinct unnamed per-stage slots. It shares
      // their buffer; it does not deduplicate these slots by node identity.
      expect(dualStage[0].bindings[0].uniforms).toHaveLength(48);
      expect(
        new Set(
          dualStage[0].bindings[0].uniforms.map((u) => u.nodeUniform.node),
        ),
      ).toEqual(new Set(terrainLightNodes(a)));
      a.terrainUniforms.vertexLightPositions[0].value.set(1, 2, 3);
      expect(b.terrainUniforms.vertexLightPositions[0].value.toArray()).toEqual(
        [0, 0, 0],
      );
    } finally {
      a.dispose();
      b.dispose();
      await f.dispose();
    }
  });

  it("refreshes on nested reflection entry and resumed primary, not on repeated chunk draws", async () => {
    const f = await bindingFixture(),
      material = createTerrainMaterial();
    const frame = new THREE.NodeFrame(),
      group = THREE.TSL.renderGroup;
    try {
      const primary = f.renderBuffer(material),
        mirror = f.renderBuffer(material, f.reflection);
      const version = group.version;
      frame.renderId = 10;
      frame.updateNode(group);
      expect(group.version).toBe(version + 1);
      expect(f.manager.updateGroup(primary)).toBe(true);
      frame.updateNode(group);
      expect(group.version).toBe(version + 1);
      expect(f.manager.updateGroup(primary)).toBe(false);
      frame.renderId = 11;
      frame.updateNode(group);
      expect(f.manager.updateGroup(mirror)).toBe(true);
      frame.renderId = 10;
      frame.updateNode(group);
      expect(group.version).toBe(version + 3);
      expect(f.manager.updateGroup(primary)).toBe(true);
      expect(f.manager.updateGroup(primary)).toBe(false);
    } finally {
      material.dispose();
      await f.dispose();
    }
  });

  it("packs real changed values on the next render without coupling terrain owners", async () => {
    const f = await bindingFixture(),
      a = createTerrainMaterial(),
      b = createTerrainMaterial();
    const frame = new THREE.NodeFrame();
    try {
      const first = f.renderBuffer(a),
        other = f.renderBuffer(b);
      frame.renderId = 20;
      frame.updateNode(THREE.TSL.renderGroup);
      for (const buffer of [first, other]) {
        expect(f.manager.updateGroup(buffer)).toBe(true);
        buffer.update();
        buffer.clearUpdateRanges();
      }
      const before = first.buffer.slice(),
        untouched = other.buffer.slice();
      updateTerrainVertexLights(a.terrainUniforms, [
        {
          position: new THREE.Vector3(2, 3, 4),
          color: new THREE.Color(0.25, 0.5, 0.75),
          intensity: 1.5,
          range: 18,
        },
      ]);
      // World-owned writes precede the next render; they are not per-draw setters.
      expect(f.manager.updateGroup(first)).toBe(false);
      expect(first.buffer).toEqual(before);
      frame.renderId++;
      frame.updateNode(THREE.TSL.renderGroup);
      expect(f.manager.updateGroup(first)).toBe(true);
      expect(first.update()).toBe(true);
      const packed = (node: TerrainLightNode) => {
        const uniform = first.uniforms.find(
          (u) => u.nodeUniform.node === node,
        )!;
        return Array.from(
          first.buffer.slice(uniform.offset, uniform.offset + uniform.itemSize),
        );
      };
      expect(packed(a.terrainUniforms.vertexLightPositions[0])).toEqual([
        2, 3, 4,
      ]);
      expect(packed(a.terrainUniforms.vertexLightColors[0])).toEqual([
        0.25, 0.5, 0.75,
      ]);
      expect(packed(a.terrainUniforms.vertexLightParams[0])).toEqual([1.5, 18]);
      expect(packed(a.terrainUniforms.vertexLightParams[1])).toEqual([0, 1]);
      expect(f.manager.updateGroup(other)).toBe(true);
      expect(other.update()).toBe(false);
      expect(other.buffer).toEqual(untouched);
      expect(f.manager.updateGroup(first)).toBe(false);
    } finally {
      a.dispose();
      b.dispose();
      await f.dispose();
    }
  });

  it("retains shared buffers but still clones ordinary per-object bindings", async () => {
    const f = await bindingFixture(),
      material = createTerrainMaterial();
    try {
      const groups = f.bindings(material, [
        ...terrainLightNodes(material),
        material.terrainUniforms.sunPosition,
      ]);
      const first = f.instanceBindings(groups),
        second = f.instanceBindings(groups);
      const shared = groups.find((g) => g.name === "render")!;
      const object = groups.find((g) => g.name === "object")!;
      expect(shared).toBeDefined();
      expect(object).toBeDefined();
      expect(first.find((g) => g.name === "render")).toBe(shared);
      expect(second.find((g) => g.name === "render")).toBe(shared);
      const firstObject = first.find((g) => g.name === "object")!;
      const secondObject = second.find((g) => g.name === "object")!;
      expect(firstObject).not.toBe(object);
      expect(firstObject).not.toBe(secondObject);
      expect(firstObject.bindings[0]).not.toBe(secondObject.bindings[0]);
    } finally {
      material.dispose();
      await f.dispose();
    }
  });
});
