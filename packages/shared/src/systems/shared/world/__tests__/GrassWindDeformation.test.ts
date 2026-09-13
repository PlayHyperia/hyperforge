import { describe, expect, it } from "vitest";
import type { Node } from "three/webgpu";
import THREE, {
  cameraViewMatrix,
  modelWorldMatrix,
  time,
} from "../../../../extras/three/three";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";
import {
  CURVED_MEADOW_APPEARANCE,
  DENSE_MEADOW_GRASS_VISUAL_PROFILE,
  GRASS_CONFIG,
  GrassVisualManager,
  NATURAL_TUFT_APPEARANCE,
  type GrassWorkerSetup,
} from "../GrassVisualManager";
import { SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE } from "../WorldTerrainProfile";

function createOwner(candidate = true) {
  const terrain = SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE;
  const config = createTerrainWorkerConfig(terrain, 16);
  const setup: GrassWorkerSetup = {
    terrainConfig: config,
    seed: terrain.seed,
    biomeCenters: [],
    biomes: {},
    grassConfigs: {},
    tileSize: terrain.terrainTileSize,
    getRoadSegmentsForRegion: () => [],
    getTerrainSurfaceForRegion: () => {
      throw new Error("Material arithmetic must not generate placements");
    },
  };
  return new GrassVisualManager(
    config.TERRAIN_PROFILE_IDENTITY,
    new THREE.Group(),
    () => null,
    () => 28,
    terrain.water.threshold,
    () => 0,
    () => false,
    () => ({
      r: 0.2,
      g: 0.4,
      b: 0.1,
      grassWeight: 1,
      grassPlacement: 1,
      grassHeightScale: 1,
    }),
    setup,
    DENSE_MEADOW_GRASS_VISUAL_PROFILE,
    undefined,
    undefined,
    undefined,
    candidate ? NATURAL_TUFT_APPEARANCE.id : undefined,
  );
}

function graph(root: Node): Set<Node> {
  const found = new Set<Node>();
  const visit = (node: Node) => {
    if (found.has(node)) return;
    if (found.size > 4096) throw new Error("Unexpected shader graph growth");
    found.add(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return found;
}

interface Inputs {
  attributes: Record<string, number[]>;
  varyings?: Record<string, number[]>;
  model: THREE.Matrix4;
  view: THREE.Matrix4;
  time: number;
  front: boolean;
}

/** Evaluates the actual constructed TSL arithmetic, never a replacement shader
 * or renderer. Unknown nodes fail closed; this is not native GPU evidence. */
function evaluate(root: Node, inputs: Inputs): number[] {
  const cache = new Map<Node, number[]>();
  const visit = (node: Node): number[] => {
    const cached = cache.get(node);
    if (cached) return cached;
    const read = (key: string): unknown => Reflect.get(node, key);
    const child = (key: string) => {
      const next = read(key);
      if (!(next instanceof THREE.Node))
        throw new Error(`Missing ${key} on ${node.type}`);
      return visit(next);
    };
    const calculate = (): number[] => {
      if (node === modelWorldMatrix) return inputs.model.toArray();
      if (node === cameraViewMatrix) return inputs.view.toArray();
      if (node === time) return [inputs.time];
      if (node.type === "FrontFacingNode") return [Number(inputs.front)];
      if (node.type === "AttributeNode") {
        const values = inputs.attributes[String(read("_attributeName"))];
        if (!values)
          throw new Error(
            `Unexpected attribute ${String(read("_attributeName"))}`,
          );
        return values;
      }
      const value = read("value");
      if (typeof value === "number") return [value];
      if (value instanceof THREE.Vector3) return value.toArray();
      if (node.type === "VaryingNode" && inputs.varyings) {
        const name = String(read("name"));
        const varying = inputs.varyings[name];
        if (!varying) throw new Error(`Missing fragment varying ${name}`);
        return varying;
      }
      if (
        ["VarNode", "VaryingNode", "ConvertNode", "SubBuild"].includes(
          node.type,
        )
      )
        return child("node");
      if (node.type === "JoinNode") {
        const children = read("nodes");
        if (!Array.isArray(children)) throw new Error("Missing joined nodes");
        return children.flatMap((next: unknown) => {
          if (!(next instanceof THREE.Node))
            throw new Error("Invalid joined node");
          return visit(next);
        });
      }
      if (node.type === "SplitNode")
        return [...String(read("components"))].map(
          (c) => child("node")["xyzw".indexOf(c)],
        );
      if (node.type === "ConditionalNode")
        return child("condNode")[0] ? child("ifNode") : child("elseNode");
      const a = child("aNode");
      const method = read("method");
      if (method === "normalize") {
        const length = Math.hypot(...a);
        return a.map((x) => x / length);
      }
      if (method === "sin") return a.map(Math.sin);
      if (method === "cos") return a.map(Math.cos);
      if (method === "negate") return a.map((x) => -x);
      const b = child("bNode");
      if (method === "dot") return [a.reduce((sum, x, i) => sum + x * b[i], 0)];
      if (read("op") === "*" && a.length === 16 && b.length === 4) {
        return new THREE.Vector4(b[0], b[1], b[2], b[3])
          .applyMatrix4(new THREE.Matrix4().fromArray(a))
          .toArray();
      }
      if (method === "transformDirection") {
        return new THREE.Vector3(b[0], b[1], b[2])
          .transformDirection(new THREE.Matrix4().fromArray(a))
          .toArray();
      }
      const operands = [a, b];
      if (read("cNode") instanceof THREE.Node) operands.push(child("cNode"));
      return Array.from(
        { length: Math.max(...operands.map((v) => v.length)) },
        (_, i) => {
          const [x, y, z] = operands.map((v) => v[v.length === 1 ? 0 : i]);
          if (read("op") === "+") return x + y;
          if (read("op") === "-") return x - y;
          if (read("op") === "*") return x * y;
          if (read("op") === "/") return x / y;
          if (read("op") === ">") return Number(x > y);
          if (method === "pow") return Math.pow(x, y);
          if (method === "max") return Math.max(x, y);
          if (method === "mix") return x + (y - x) * z;
          if (method === "clamp") return Math.min(z, Math.max(y, x));
          if (method === "smoothstep") {
            const t = Math.min(1, Math.max(0, (z - x) / (y - x)));
            return t * t * (3 - 2 * t);
          }
          throw new Error(
            `Unsupported ${node.type} ${String(method)} ${String(read("op"))}`,
          );
        },
      );
    };
    const result = calculate();
    if (result.some((x) => !Number.isFinite(x)))
      throw new Error(`Nonfinite ${node.type}`);
    cache.set(node, result);
    return result;
  };
  return visit(root);
}

function vector(values: number[]) {
  return new THREE.Vector3(values[0], values[1], values[2]);
}

function inputFor(geometry: THREE.BufferGeometry, index: number): Inputs {
  return {
    attributes: {
      position: new THREE.Vector3()
        .fromBufferAttribute(geometry.attributes.position, index)
        .toArray(),
      normal: new THREE.Vector3()
        .fromBufferAttribute(geometry.attributes.normal, index)
        .toArray(),
      uv: [
        geometry.attributes.uv.getX(index),
        geometry.attributes.uv.getY(index),
      ],
      instanceOffset: [4, 28, 7],
      instanceRotScaleHash: [0.7, 1.1, 0.3],
      instanceGroundNormal: [0, 1, 0],
    },
    model: new THREE.Matrix4().makeTranslation(350, 0, 350),
    view: new THREE.Matrix4(),
    time: 3.7,
    front: true,
  };
}

function worldBase(inputs: Inputs) {
  const offset = inputs.attributes.instanceOffset;
  return new THREE.Vector3(offset[0], 0, offset[2]).applyMatrix4(inputs.model);
}

function windAmplitude(inputs: Inputs) {
  const base = worldBase(inputs);
  const wt = inputs.time * GRASS_CONFIG.WIND_SPEED;
  const strength =
    GRASS_CONFIG.WIND_STRENGTH * NATURAL_TUFT_APPEARANCE.BLADE_HEIGHT_MAX;
  return new THREE.Vector3(
    Math.sin(wt + base.x * 0.35 + base.z * 0.12) * strength,
    0,
    Math.sin(wt * 0.67 + base.x * 0.18 + base.z * 0.28 + 2) * strength * 0.55,
  );
}

function rotation(inputs: Inputs) {
  const up = new THREE.Vector3(0, 1, 0);
  return new THREE.Quaternion()
    .setFromUnitVectors(up, vector(inputs.attributes.instanceGroundNormal))
    .multiply(
      new THREE.Quaternion().setFromAxisAngle(
        up,
        -inputs.attributes.instanceRotScaleHash[0],
      ),
    );
}

describe("natural tuft actual shader deformation (CPU node arithmetic only)", () => {
  it("keeps actual fragment normals finite after zero or near-zero raster interpolation", () => {
    const owner = createOwner();
    try {
      const material = owner["material"];
      const fragment = graph(material.normalNode!);
      expect(
        [...fragment].some(
          (node) =>
            Reflect.get(node, "name") === "naturalGrassInterpolatedLengthSq",
        ),
      ).toBe(true);
      const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.2, 1000);
      camera.position.set(25, 19, -31);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      for (const ground of [
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0.4, 0.8, -0.3).normalize(),
      ])
        for (const front of [false, true])
          for (const interpolated of [
            [0, 0, 0], // equal interpolation of opposing valid vertex normals
            [1e-9, -1e-9, 0],
            [0, 0.999e-6, 0],
            [0, 1.001e-6, 0],
            [0.3, -0.2, 0.4],
            ground.clone().negate().toArray(),
          ]) {
            const inputs = inputFor(owner["lodGeometries"][1], 0);
            inputs.attributes.instanceGroundNormal = ground.toArray();
            inputs.varyings = { v_curvedGrassNormal: interpolated };
            inputs.view.copy(camera.matrixWorldInverse);
            inputs.front = front;
            // Exercise the real fragment graph with raster-interpolated inputs,
            // not the vertex expression hidden behind the VaryingNode.
            const actual = vector(evaluate(material.normalNode!, inputs));
            const blade = new THREE.Vector3().fromArray(interpolated);
            if (blade.lengthSq() <= 1e-12) blade.copy(ground);
            else blade.normalize();
            const blended = ground
              .clone()
              .lerp(
                blade.multiplyScalar(front ? 1 : -1),
                NATURAL_TUFT_APPEARANCE.BLADE_NORMAL_WEIGHT,
              );
            // A 0.38 unit-blade blend with the unit terrain normal cannot
            // cancel: its pre-normalization length is at least 1 - 2*0.38.
            expect(blended.length()).toBeGreaterThanOrEqual(0.24 - 1e-12);
            const expected = blended
              .normalize()
              .transformDirection(inputs.view);
            expect(actual.length()).toBeCloseTo(1, 12);
            expect(actual.distanceTo(expected)).toBeLessThan(1e-12);
          }
    } finally {
      owner.destroy();
    }
  });

  it("shares the world-space displacement and fade without new attributes, textures, or varyings", () => {
    const owner = createOwner();
    const old = createOwner(false);
    try {
      const material = owner["material"];
      const position = graph(material.positionNode!);
      const normals = graph(material.normalNode!);
      for (const name of [
        "naturalGrassDisplacement",
        "naturalGrassFade",
        "naturalGrassWorldBase",
      ]) {
        const shared = [...position].filter(
          (n) => Reflect.get(n, "name") === name,
        );
        expect(shared).toHaveLength(1);
        expect(normals.has(shared[0])).toBe(true);
      }
      const union = new Set([...position, ...normals]);
      expect(
        [...union].filter((n) => Reflect.get(n, "method") === "sin"),
      ).toHaveLength(3); // two wind waves + yaw
      expect(
        [...union].filter((n) => {
          const exponent: unknown = Reflect.get(n, "bNode");
          return (
            Reflect.get(n, "method") === "pow" &&
            exponent instanceof THREE.Node &&
            evaluate(exponent, inputFor(owner["lodGeometries"][1], 0))[0] ===
              1.8
          );
        }),
      ).toHaveLength(1);
      expect(
        [...union]
          .filter((n) => n.type === "VaryingNode")
          .map((n) => Reflect.get(n, "name")),
      ).toEqual(["v_curvedGrassNormal"]);
      expect(
        [
          ...new Set(
            [...union]
              .filter((n) => n.type === "AttributeNode")
              .map((n) => Reflect.get(n, "_attributeName")),
          ),
        ].sort(),
      ).toEqual([
        "instanceGroundNormal",
        "instanceOffset",
        "instanceRotScaleHash",
        "normal",
        "position",
        "uv",
      ]);
      expect(material.map).toBeNull();
      expect(material.normalMap).toBeNull();
      expect(material.alphaMap).toBeNull();
      expect(old["material"].name).toBe(CURVED_MEADOW_APPEARANCE.id);
      expect(graph(old["material"].normalNode!).has(time)).toBe(false);
      expect(graph(old["material"].normalNode!).has(modelWorldMatrix)).toBe(
        false,
      );
    } finally {
      owner.destroy();
      old.destroy();
    }
  });

  it("gives identical world positions and normals to the same clump under different chunk origins", () => {
    const owner = createOwner();
    try {
      const geometry = owner["lodGeometries"][1];
      for (const index of [0, 1, 2, 3, 4])
        for (const seconds of [0, 0.1, 2.3, 29]) {
          const a = inputFor(geometry, index);
          a.time = seconds;
          owner["playerPosUniform"]!.value.copy(worldBase(a));
          const b = inputFor(geometry, index);
          b.time = seconds;
          b.model.makeTranslation(300, 0, 400);
          b.attributes.instanceOffset = [54, 28, -43];
          const positionA = vector(
            evaluate(owner["material"].positionNode!, a),
          ).applyMatrix4(a.model);
          const positionB = vector(
            evaluate(owner["material"].positionNode!, b),
          ).applyMatrix4(b.model);
          expect(positionA.distanceTo(positionB)).toBeLessThan(1e-12);
          expect(
            vector(evaluate(owner["material"].normalNode!, a)).distanceTo(
              vector(evaluate(owner["material"].normalNode!, b)),
            ),
          ).toBeLessThan(1e-12);
        }
    } finally {
      owner.destroy();
    }
  });

  it("reduces to the independent fade cofactor at a zero-wave world phase, including completely collapsed roots", () => {
    const owner = createOwner();
    try {
      // Solve both world-space phase equations at time zero; this exercises the
      // actual wind inputs without replacing or switching off the shader path.
      const z = -2 / (0.28 - (0.18 * 0.12) / 0.35);
      const x = (-0.12 * z) / 0.35;
      const geometry = owner["lodGeometries"][1];
      const ground = new THREE.Vector3(0.4, 0.8, -0.3).normalize();
      for (const index of [0, 1, 2, 3, 4])
        for (const distance of [0, 126, 140]) {
          const inputs = inputFor(geometry, index);
          inputs.model.identity();
          inputs.attributes.instanceOffset = [x, 28, z];
          inputs.attributes.instanceGroundNormal = ground.toArray();
          inputs.time = 0;
          owner["playerPosUniform"]!.value.copy(worldBase(inputs)).add(
            new THREE.Vector3(distance, 0, 0),
          );
          expect(windAmplitude(inputs).length()).toBeLessThan(1e-16);
          const f = distance === 0 ? 1 : distance === 126 ? 0.5 : 0;
          const normal = vector(inputs.attributes.normal);
          normal.x *= f;
          normal.z *= f;
          normal.applyQuaternion(rotation(inputs));
          const expectedBlade =
            normal.lengthSq() > 1e-12 ? normal.normalize() : ground.clone();
          const expected = ground
            .clone()
            .lerp(expectedBlade, NATURAL_TUFT_APPEARANCE.BLADE_NORMAL_WEIGHT)
            .normalize();
          const actual = vector(
            evaluate(owner["material"].normalNode!, inputs),
          );
          expect(actual.distanceTo(expected)).toBeLessThan(1e-12);
          expect(actual.length()).toBeCloseTo(1, 12);
        }
    } finally {
      owner.destroy();
    }
  });

  it("matches the actual deformed smooth normal to independent tangent crosses through wind, fade, yaw and slope", () => {
    const owner = createOwner();
    let cases = 0;
    let maximumError = 0;
    try {
      const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.2, 1000);
      camera.position.set(25, 19, -31);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      for (const [lod, geometry] of owner["lodGeometries"].entries()) {
        const vertices = GRASS_CONFIG.LOD_TIERS[lod].bladeSegments * 2 + 1;
        for (const blade of [
          0,
          GRASS_CONFIG.LOD_TIERS[lod].bladesPerClump - 1,
        ]) {
          const root = blade * vertices;
          const left = new THREE.Vector3().fromBufferAttribute(
            geometry.attributes.position,
            root,
          );
          const right = new THREE.Vector3().fromBufferAttribute(
            geometry.attributes.position,
            root + 1,
          );
          const center = left.clone().add(right).multiplyScalar(0.5);
          const width = right.clone().sub(left).normalize();
          const tip = new THREE.Vector3().fromBufferAttribute(
            geometry.attributes.position,
            root + vertices - 1,
          );
          const height = tip.y / NATURAL_TUFT_APPEARANCE.BLADE_TIP_HEIGHT;
          const curve = tip.clone().sub(center);
          for (const index of [
            root,
            root + Math.min(2, vertices - 1),
            root + vertices - 1,
          ])
            for (const ground of [
              new THREE.Vector3(0, 1, 0),
              new THREE.Vector3(0.4, 0.8, -0.3).normalize(),
              new THREE.Vector3(-0.6, 0.7, 0.2).normalize(),
            ])
              for (const scale of [0.14, 1.1, 4])
                for (const fadeDistance of [0, 126, 140])
                  for (const seconds of [0, 3.7]) {
                    const inputs = inputFor(geometry, index);
                    inputs.attributes.instanceGroundNormal = ground.toArray();
                    inputs.attributes.instanceRotScaleHash = [
                      0.4 + lod + seconds,
                      scale,
                      0.3,
                    ];
                    inputs.time = seconds;
                    inputs.view.copy(camera.matrixWorldInverse);
                    inputs.front = cases % 2 === 0;
                    owner["playerPosUniform"]!.value.copy(
                      worldBase(inputs),
                    ).add(new THREE.Vector3(fadeDistance, 0, 0));
                    const fadeT = Math.min(
                      1,
                      Math.max(0, (fadeDistance - 112) / 28),
                    );
                    const fade = 1 - fadeT * fadeT * (3 - 2 * fadeT);
                    const t = inputs.attributes.uv[1];
                    const derivativeY =
                      2 *
                      height *
                      (NATURAL_TUFT_APPEARANCE.BLADE_CONTROL_HEIGHT +
                        t *
                          (NATURAL_TUFT_APPEARANCE.BLADE_TIP_HEIGHT -
                            2 * NATURAL_TUFT_APPEARANCE.BLADE_CONTROL_HEIGHT));
                    const tangentWidth = width
                      .clone()
                      .multiplyScalar(scale)
                      .applyQuaternion(rotation(inputs));
                    const tangentHeight = new THREE.Vector3(
                      2 * curve.x * t,
                      derivativeY * fade,
                      2 * curve.z * t,
                    )
                      .multiplyScalar(scale)
                      .applyQuaternion(rotation(inputs))
                      .add(
                        windAmplitude(inputs).multiplyScalar(
                          1.8 * Math.pow(t, 0.8),
                        ),
                      );
                    const cross = tangentWidth.cross(tangentHeight);
                    const smooth =
                      cross.lengthSq() < 1e-20
                        ? ground.clone()
                        : cross.normalize();
                    const expected = ground
                      .clone()
                      .lerp(
                        smooth.multiplyScalar(inputs.front ? 1 : -1),
                        NATURAL_TUFT_APPEARANCE.BLADE_NORMAL_WEIGHT,
                      )
                      .normalize()
                      .transformDirection(inputs.view);
                    const actual = vector(
                      evaluate(owner["material"].normalNode!, inputs),
                    );
                    maximumError = Math.max(
                      maximumError,
                      actual.distanceTo(expected),
                    );
                    expect(actual.length()).toBeCloseTo(1, 12);
                    expect(actual.distanceTo(expected)).toBeLessThan(2e-6); // source Float32 position/normal rounding
                    const position = vector(inputs.attributes.position);
                    position.y *= fade;
                    position
                      .multiplyScalar(scale)
                      .applyQuaternion(rotation(inputs))
                      .add(
                        windAmplitude(inputs).multiplyScalar(Math.pow(t, 1.8)),
                      )
                      .add(vector(inputs.attributes.instanceOffset));
                    expect(
                      vector(
                        evaluate(owner["material"].positionNode!, inputs),
                      ).distanceTo(position),
                    ).toBeLessThan(1e-12);
                    cases++;
                  }
        }
      }
      expect(cases).toBe(972);
      expect(maximumError).toBeLessThan(2e-6);
    } finally {
      owner.destroy();
    }
  });

  it("keeps both roots anchored over time and all vertex wind inside existing swept bounds", () => {
    const owner = createOwner();
    try {
      for (const [lod, geometry] of owner["lodGeometries"].entries()) {
        const vertices = GRASS_CONFIG.LOD_TIERS[lod].bladeSegments * 2 + 1;
        for (
          let index = 0;
          index < geometry.attributes.position.count;
          index++
        ) {
          const inputs = inputFor(geometry, index);
          inputs.attributes.instanceGroundNormal = new THREE.Vector3(
            0.3,
            0.8,
            -0.4,
          )
            .normalize()
            .toArray();
          owner["playerPosUniform"]!.value.copy(worldBase(inputs));
          const base = vector(inputs.attributes.position)
            .multiplyScalar(inputs.attributes.instanceRotScaleHash[1])
            .applyQuaternion(rotation(inputs))
            .add(vector(inputs.attributes.instanceOffset));
          const t = inputs.attributes.uv[1];
          for (const seconds of [0, 1.1, 3.7, 20, 100]) {
            inputs.time = seconds;
            const delta = vector(
              evaluate(owner["material"].positionNode!, inputs),
            ).sub(base);
            const cap =
              GRASS_CONFIG.WIND_STRENGTH *
              NATURAL_TUFT_APPEARANCE.BLADE_HEIGHT_MAX *
              Math.pow(t, 1.8);
            expect(Math.abs(delta.x)).toBeLessThanOrEqual(cap + 1e-13);
            expect(Math.abs(delta.z)).toBeLessThanOrEqual(cap * 0.55 + 1e-13);
            expect(Math.abs(delta.y)).toBeLessThan(1e-13);
            if (index % vertices < 2)
              expect(delta.length()).toBeLessThan(1e-13);
          }
        }
      }
    } finally {
      owner.destroy();
    }
  });
});
