/**
 * glbToNodes.ts - GLB to HyperForge Node Converter
 *
 * Converts GLTF/GLB scene graphs into Hyperia's custom Node system.
 * This enables GLB files exported from Blender to work with Hyperia's physics,
 * networking, and lifecycle systems.
 *
 * Conversion Process:
 * 1. Parse GLB scene hierarchy (THREE.Scene/Group/Mesh objects)
 * 2. Convert each THREE object to appropriate Node type
 * 3. Preserve hierarchy, transforms, and custom properties
 * 4. Set up physics for rigidbody/collider nodes
 * 5. Configure LOD levels if specified
 *
 * Supported Node Types:
 * - Scene/Group/Object3D → 'group' node (container)
 * - Mesh → 'mesh' node (renderable geometry)
 * - SkinnedMesh → 'skinnedmesh' node (animated character)
 * - Custom: node="rigidbody" → Physics-enabled object
 * - Custom: node="collider" → Collision shape
 * - Custom: node="lod" → Level-of-detail container
 *
 * Custom Properties (set in Blender via Custom Properties panel):
 * - node: 'rigidbody' | 'collider' | 'lod' (type override)
 * - type: 'static' | 'dynamic' | 'kinematic' (rigidbody type)
 * - mass: number (rigidbody mass)
 * - convex: boolean (collider convexity)
 * - trigger: boolean (collider is trigger)
 * - maxDistance: number (LOD distance threshold)
 * - scaleAware: boolean (LOD uses scale for distance)
 * - exp_splatmap: boolean (terrain splatmap shader)
 *
 * Usage:
 * ```ts
 * const glb = await loader.load('model', 'asset://models/building.glb');
 * const root = glbToNodes(glb, world);
 * root.activate(world);
 * ```
 *
 * Referenced by: ClientLoader, asset loading pipeline
 */

import { createNode } from "./createNode";
import * as THREE from "./three";
import {
  MeshStandardNodeMaterial,
  texture,
  uv,
  positionLocal,
  normalLocal,
  uniform,
  float,
  vec2,
  vec3,
  vec4,
  abs,
  pow,
  add,
  mul,
  div,
  Fn,
} from "./three";
import type { Node as TSLNode } from "three/webgpu";
import { World } from "../../core/World";
import type { Node } from "../../nodes/Node";
import type { NodeData, GLBData } from "../../types";
import type {
  MeshData,
  SkinnedMeshData,
  LODData,
} from "../../types/rendering/nodes";

/** THREE.js object types that map to Group nodes */
const groupTypes = ["Scene", "Group", "Object3D"];

/** Union type for all possible node data configurations during GLB parsing */
type GLBNodeData =
  | NodeData
  | MeshData
  | SkinnedMeshData
  | LODData
  | (NodeData & {
      object3d?: THREE.Object3D;
      animations?: unknown[];
      mass?: number;
      maxDistance?: number;
      convex?: boolean;
      trigger?: boolean;
      geometry?: THREE.BufferGeometry;
    });

/**
 * Triplanar texture sampling function using TSL
 * Used for splatmap terrain materials
 * Lazily initialized because TSL (Fn, vec2, etc.) is only available in the browser.
 */
type TSLShaderFn = (
  texture: THREE.Texture,
  scale: TSLNode<"float">,
  normal: TSLNode<"vec3">,
  position: TSLNode<"vec3">,
) => TSLNode<"vec4">;
let _triplanarSampleFn: TSLShaderFn | null = null;

/** Lazily create and return the triplanar sampling TSL function (browser only) */
function getTriplanarSample(): TSLShaderFn {
  if (!_triplanarSampleFn) {
    _triplanarSampleFn = Fn(
      ([tex, scale, normal, position]: [
        THREE.Texture,
        ReturnType<typeof float>,
        ReturnType<typeof vec3>,
        ReturnType<typeof vec3>,
      ]) => {
        // UV coordinates for each axis projection
        const uvX = vec2(mul(position.y, scale), mul(position.z, scale));
        const uvY = vec2(mul(position.x, scale), mul(position.z, scale));
        const uvZ = vec2(mul(position.x, scale), mul(position.y, scale));

        // Sample texture from three axis-aligned projections
        const xProjection = texture(tex, uvX);
        const yProjection = texture(tex, uvY);
        const zProjection = texture(tex, uvZ);

        // Calculate blend weights based on normal direction
        const weight = normal.abs();
        const weightPow = weight.pow(vec3(4.0));
        const weightSum = add(add(weightPow.x, weightPow.y), weightPow.z);
        const normalizedWeight = div(weightPow, weightSum);

        // Blend samples using normalized weights
        const xContrib = mul(xProjection, normalizedWeight.x);
        const yContrib = mul(yProjection, normalizedWeight.y);
        const zContrib = mul(zProjection, normalizedWeight.z);

        return add(add(xContrib, yContrib), zContrib);
      },
    ) as unknown as TSLShaderFn;
  }
  return _triplanarSampleFn;
}

/**
 * Convert GLB Scene Graph to HyperForge Nodes
 *
 * Recursively processes a GLB's THREE.js scene graph and converts it to Nodes.
 *
 * @param glb - Loaded GLB data (scene, animations, userData)
 * @param world - World instance for context
 * @returns Root group node containing entire hierarchy
 */
export function glbToNodes(glb: GLBData, world: World) {
  function registerNode(name: string, data: GLBNodeData) {
    const node = createNode(name, data);
    return node;
  }
  interface ParentNode {
    name: string;
    add: (node: Node) => void;
    insert: (node: Node, distance: number) => void;
  }

  function wrapNodeAsParent(node: Node): ParentNode {
    return {
      name: node.name,
      add: (childNode: Node) => node.add(childNode),
      insert: (childNode: Node, distance: number) => {
        // Only LOD nodes have insert method
        if ("insert" in node) {
          (
            node as Node & { insert: (child: Node, distance: number) => void }
          ).insert(childNode, distance);
        } else {
          node.add(childNode);
        }
      },
    };
  }

  function parse(object3ds: THREE.Object3D[], parentNode: ParentNode) {
    for (const object3d of object3ds) {
      const props = object3d.userData || {};
      const isSkinnedMeshRoot = !!object3d.children.find(
        (c) =>
          (c as THREE.Object3D & { isSkinnedMesh?: boolean }).isSkinnedMesh,
      );
      // SkinnedMesh (root)
      if (isSkinnedMeshRoot) {
        const node = registerNode("skinnedmesh", {
          id: object3d.name,
          object3d,
          animations: glb.animations || [],
          castShadow: props.castShadow,
          receiveShadow: props.receiveShadow,
          active: props.active,
          position: object3d.position.toArray() as [number, number, number],
          quaternion: [
            object3d.quaternion.x,
            object3d.quaternion.y,
            object3d.quaternion.z,
            object3d.quaternion.w,
          ] as [number, number, number, number],
          scale: object3d.scale.toArray() as [number, number, number],
        });
        if (parentNode.name === "lod" && props.maxDistance) {
          parentNode.insert(node, props.maxDistance);
        } else {
          parentNode.add(node);
        }
      }
      // LOD (custom node)
      else if (props.node === "lod") {
        const node = registerNode("lod", {
          id: object3d.name,
          position: object3d.position.toArray() as [number, number, number],
          quaternion: [
            object3d.quaternion.x,
            object3d.quaternion.y,
            object3d.quaternion.z,
            object3d.quaternion.w,
          ] as [number, number, number, number],
          scale: object3d.scale.toArray() as [number, number, number],
          scaleAware: props.scaleAware,
        });
        parentNode.add(node);
        parse(object3d.children as THREE.Object3D[], wrapNodeAsParent(node));
      }
      // RigidBody (custom node)
      else if (props.node === "rigidbody") {
        const node = registerNode("rigidbody", {
          id: object3d.name,
          type: props.type,
          mass: props.mass,
          position: object3d.position.toArray() as [number, number, number],
          quaternion: [
            object3d.quaternion.x,
            object3d.quaternion.y,
            object3d.quaternion.z,
            object3d.quaternion.w,
          ] as [number, number, number, number],
          scale: object3d.scale.toArray() as [number, number, number],
        });
        parentNode.add(node);
        parse(object3d.children as THREE.Object3D[], wrapNodeAsParent(node));
      }
      // Collider (custom node)
      else if (props.node === "collider" && object3d instanceof THREE.Mesh) {
        const mesh = object3d;
        const node = registerNode("collider", {
          id: mesh.name,
          type: "geometry",
          geometry: mesh.geometry,
          convex: props.convex,
          trigger: props.trigger,
          position: mesh.position.toArray() as [number, number, number],
          quaternion: [
            mesh.quaternion.x,
            mesh.quaternion.y,
            mesh.quaternion.z,
            mesh.quaternion.w,
          ] as [number, number, number, number],
          scale: mesh.scale.toArray() as [number, number, number],
        });
        parentNode.add(node);
        parse(mesh.children as THREE.Object3D[], wrapNodeAsParent(node));
      }
      // Mesh
      else if (object3d.type === "Mesh") {
        if (!(object3d instanceof THREE.Mesh)) {
          continue;
        }
        const mesh = object3d;

        // Ensure vertex normals exist for WebGPU standard materials
        if (mesh.geometry && !mesh.geometry.attributes.normal) {
          mesh.geometry.computeVertexNormals();
        }

        // experimental splatmaps using TSL
        if (props.exp_splatmap && !world.network.isServer) {
          setupSplatmapTSL(mesh);
        }
        const hasMorphTargets =
          (
            mesh as THREE.Mesh & {
              morphTargetDictionary?: unknown;
              morphTargetInfluences?: unknown[];
            }
          ).morphTargetDictionary ||
          ((mesh as THREE.Mesh & { morphTargetInfluences?: unknown[] })
            .morphTargetInfluences?.length ?? 0) > 0;
        const node = registerNode("mesh", {
          id: mesh.name,
          type: "geometry",
          geometry: mesh.geometry,
          material: mesh.material,
          linked: !hasMorphTargets,
          castShadow: props.castShadow,
          receiveShadow: props.receiveShadow,
          visible: props.visible,
          active: props.active,
          position: mesh.position.toArray() as [number, number, number],
          quaternion: [
            mesh.quaternion.x,
            mesh.quaternion.y,
            mesh.quaternion.z,
            mesh.quaternion.w,
          ] as [number, number, number, number],
          scale: mesh.scale.toArray() as [number, number, number],
        });
        if (parentNode.name === "lod" && props.maxDistance) {
          parentNode.insert(node, props.maxDistance);
        } else {
          parentNode.add(node);
        }
        parse(mesh.children as THREE.Object3D[], wrapNodeAsParent(node));
      }
      // SkinnedMesh
      else if (object3d.type === "SkinnedMesh") {
        // Handled by isSkinnedMeshRoot above
      }
      // Object3D / Group / Scene
      else if (groupTypes.includes(object3d.type)) {
        const node = registerNode("group", {
          id: object3d.name,
          position: object3d.position.toArray() as [number, number, number],
          quaternion: [
            object3d.quaternion.x,
            object3d.quaternion.y,
            object3d.quaternion.z,
            object3d.quaternion.w,
          ] as [number, number, number, number],
          scale: object3d.scale.toArray() as [number, number, number],
        });
        parentNode.add(node);
        parse(object3d.children as THREE.Object3D[], wrapNodeAsParent(node));
      }
    }
  }
  const root = registerNode("group", {
    id: "$root",
  });
  parse(glb.scene.children as THREE.Object3D[], wrapNodeAsParent(root));
  return root;
}

/**
 * Setup splatmap terrain material using TSL Node Materials
 *
 * Creates a triplanar-projected multi-texture splatmap material.
 * Textures are stored in material slots and reconstructed here.
 *
 * @param mesh - The mesh to apply splatmap material to
 */
function setupSplatmapTSL(mesh: THREE.Mesh) {
  const triplanarSample = getTriplanarSample();
  interface MaterialWithTextures extends THREE.Material {
    map?: THREE.Texture;
    specularIntensityMap?: THREE.Texture;
    transmissionMap?: THREE.Texture;
    emissiveMap?: THREE.Texture;
    normalMap?: THREE.Texture;
  }

  const original = mesh.material as MaterialWithTextures;

  // Ensure textures have correct color space
  if (original.specularIntensityMap) {
    original.specularIntensityMap.colorSpace = THREE.SRGBColorSpace;
  }
  if (original.transmissionMap) {
    original.transmissionMap.colorSpace = THREE.SRGBColorSpace;
  }
  if (original.emissiveMap) {
    original.emissiveMap.colorSpace = THREE.SRGBColorSpace;
  }
  if (original.normalMap) {
    original.normalMap.colorSpace = THREE.SRGBColorSpace;
  }

  // Get textures from material slots
  const splatTex = original.map;
  const rTex = original.specularIntensityMap;
  const gTex = original.emissiveMap;
  const bTex = original.normalMap;
  const aTex = original.transmissionMap;

  // GLB extras are untyped input; only finite numeric UV scales become uniforms.
  const scaleValue = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value !== 0
      ? value
      : 1;
  const rScale = uniform(scaleValue(mesh.userData.red_scale));
  const gScale = uniform(scaleValue(mesh.userData.green_scale));
  const bScale = uniform(scaleValue(mesh.userData.blue_scale));
  const aScale = uniform(scaleValue(mesh.userData.alpha_scale));

  // Create TSL Node Material
  const material = new MeshStandardNodeMaterial();
  material.roughness = 1;
  material.metalness = 0;

  // Create splatmap color node
  const splatmapColorNode = Fn(() => {
    const uvCoord = uv();
    const norm = normalLocal;
    const pos = positionLocal;

    // Sample splatmap to get blend weights
    const splat = splatTex ? texture(splatTex, uvCoord) : vec4(1, 0, 0, 0);

    // Initialize result color
    let result: TSLNode<"vec4"> = vec4(0, 0, 0, 1);

    // Red channel texture
    if (rTex) {
      const rSample = triplanarSample(rTex, rScale, norm, pos);
      result = add(result, rSample.mul(splat.r));
    }

    // Green channel texture
    if (gTex) {
      const gSample = triplanarSample(gTex, gScale, norm, pos);
      result = add(result, gSample.mul(splat.g));
    }

    // Blue channel texture
    if (bTex) {
      const bSample = triplanarSample(bTex, bScale, norm, pos);
      result = add(result, bSample.mul(splat.b));
    }

    // Alpha channel texture (optional)
    if (aTex) {
      const aSample = triplanarSample(aTex, aScale, norm, pos);
      result = add(result, aSample.mul(splat.a));
    }

    return result.rgb;
  })();

  material.colorNode = splatmapColorNode;

  // Apply the new material
  mesh.material = material;
}
