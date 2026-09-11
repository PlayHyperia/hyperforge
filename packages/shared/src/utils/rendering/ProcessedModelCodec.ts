import THREE, { MeshStandardNodeMaterial } from "../../extras/three/three";
import type { ModelCollisionData } from "./ModelCache";

/** A processed representation, not a replacement for GLTFLoader or an authored-PBR policy. */
export const PROCESSED_MODEL_VERSION = 7;
const POLICY = "static-r186-rgba8-v1";
export const PROCESSED_MODEL_LIMITS = Object.freeze({
  sourceBytes: 256 * 1024 * 1024,
  payloadBytes: 256 * 1024 * 1024,
  jsonBytes: 1024 * 1024,
  nodes: 4096,
  geometries: 1024,
  materials: 512,
  textures: 128,
  sources: 128,
  dimension: 8192,
  depth: 64,
});

export type ProcessedModelSource = Readonly<{
  byteLength: number;
  sha256: string;
}>;
type Scalar = string | number | boolean | null;
type State = Record<string, Scalar | number[]>;
type Json = Scalar | Json[] | { [key: string]: Json };
type AttributeRecord = {
  type: string;
  data: ArrayBuffer;
  itemSize: number;
  normalized: boolean;
  name: string;
  usage: number;
  gpuType: number;
};
type GeometryRecord = {
  name: string;
  attributes: Record<string, AttributeRecord>;
  index: AttributeRecord | null;
  groups: { start: number; count: number; materialIndex: number }[];
  drawRange: { start: number; count: number | null };
  boundingBox: number[] | null;
  boundingSphere: number[] | null;
  userData: Json;
};
type MaterialRecord = {
  state: State;
  maps: Record<string, number | null>;
  userData: Json;
};
type TextureRecord = { source: number; state: State; userData: Json };
type SourceRecord = {
  width: number;
  height: number;
  pixels: ArrayBuffer;
  clamped: boolean;
};
type NodeRecord = {
  kind: "Object3D" | "Group" | "Mesh";
  state: State;
  userData: Json;
  geometry: number | null;
  materials: number[] | null;
  materialArray: boolean;
  children: number[];
};
export type ProcessedModelRecord = {
  version: number;
  policy: string;
  url: string;
  source: ProcessedModelSource;
  sources: SourceRecord[];
  textures: TextureRecord[];
  materials: MaterialRecord[];
  geometries: GeometryRecord[];
  nodes: NodeRecord[];
  collision: ModelCollisionData | null;
};

const materialDefault = new MeshStandardNodeMaterial();
const textureDefault = new THREE.DataTexture();
const nodeDefault = new THREE.Object3D();
const geometryDefault = new THREE.BufferGeometry();
const attributeDefault = new THREE.BufferAttribute(new Float32Array(), 1);
const mapKeys = [
  "map",
  "normalMap",
  "emissiveMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
] as const;
const materialIgnored = new Set([
  "uuid",
  "version",
  "userData",
  "_listeners",
  "_alphaTest",
  ...mapKeys,
]);
const nullableEnums = new Set([
  "shadowSide",
  "blendSrcAlpha",
  "blendDstAlpha",
  "blendEquationAlpha",
]);
const textureIgnored = new Set([
  "uuid",
  "version",
  "source",
  "userData",
  "_listeners",
]);
const nodeKeys = [
  "name",
  "visible",
  "castShadow",
  "receiveShadow",
  "frustumCulled",
  "renderOrder",
  "matrixAutoUpdate",
  "matrixWorldAutoUpdate",
  "matrixWorldNeedsUpdate",
  "static",
  "up",
  "position",
  "quaternion",
  "scale",
  "matrix",
  "matrixWorld",
];
const nodeIgnored = new Set([
  "uuid",
  "parent",
  "children",
  "userData",
  "_listeners",
  "geometry",
  "material",
  "layers",
  "rotation",
  "animations",
  ...nodeKeys,
]);
const arrayTypes = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
};
const attributeNames = new Set([
  "position",
  "normal",
  "tangent",
  "color",
  "uv",
  "uv1",
  "uv2",
  "uv3",
]);

function check(ok: unknown): asserts ok {
  if (!ok) throw new Error("Unsupported or invalid processed static model");
}
function hasOwn(value: object, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function oneOf(value: unknown, allowed: readonly unknown[]) {
  return allowed.includes(value);
}
function object(value: unknown): Record<string, unknown> {
  check(
    value !== null &&
      typeof value === "object" &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null),
  );
  return value as Record<string, unknown>;
}
function keys(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> {
  const result = object(value);
  check(
    Object.keys(result).length === expected.length &&
      expected.every((k) => hasOwn(result, k)),
  );
  return result;
}
function integer(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  check(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= min &&
      value <= max,
  );
}
function finite(value: unknown): asserts value is number {
  check(typeof value === "number" && Number.isFinite(value));
}
function text(value: unknown): asserts value is string {
  check(typeof value === "string" && value.length <= 4096);
}
function array(value: unknown, max: number): asserts value is unknown[] {
  check(Array.isArray(value) && value.length <= max);
}
function vector(value: unknown, length: number) {
  array(value, length);
  check(value.length === length);
  value.forEach(finite);
}
function cloneJson(value: unknown, budget = new Budget()): Json {
  const seen = new Set<object>();
  const visit = (input: unknown, depth: number): Json => {
    check(depth <= 16);
    budget.json(0);
    if (input === null || typeof input === "boolean") {
      budget.json(8);
      return input;
    }
    if (typeof input === "number") {
      finite(input);
      budget.json(16);
      return input;
    }
    if (typeof input === "string") {
      budget.json(input.length * 2);
      return input;
    }
    check(typeof input === "object" && input !== null && !seen.has(input));
    seen.add(input);
    if (Array.isArray(input)) {
      const result = input.map((v) => visit(v, depth + 1));
      seen.delete(input);
      return result;
    }
    const result: { [key: string]: Json } = {};
    for (const [key, entry] of Object.entries(object(input))) {
      check(
        key !== "__proto__" && key !== "constructor" && key !== "prototype",
      );
      budget.json(key.length * 2);
      result[key] = visit(entry, depth + 1);
    }
    seen.delete(input);
    return result;
  };
  return visit(value, 0);
}
function cloneExtras(value: unknown, budget?: Budget): Record<string, Json> {
  return object(cloneJson(object(value), budget)) as Record<string, Json>;
}
function comparable(value: unknown): Scalar | number[] | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number") {
    finite(value);
    return value;
  }
  if (value instanceof THREE.Color) return [value.r, value.g, value.b];
  if (value instanceof THREE.Matrix3 || value instanceof THREE.Matrix4)
    return [...value.elements];
  if (
    value instanceof THREE.Vector2 ||
    value instanceof THREE.Vector3 ||
    value instanceof THREE.Quaternion
  )
    return value.toArray();
  return undefined;
}
function sameDefault(value: unknown, baseline: unknown): boolean {
  if (value === baseline) return true;
  if (value instanceof THREE.Euler && baseline instanceof THREE.Euler)
    return value.equals(baseline);
  try {
    return (
      JSON.stringify(cloneJson(value)) === JSON.stringify(cloneJson(baseline))
    );
  } catch {
    return false;
  }
}
/** Unknown/custom fields or changed non-serializable fields reject the entire scene. */
function stateFrom(
  value: object,
  baseline: object,
  ignored: ReadonlySet<string>,
  selected?: readonly string[],
): State {
  const result: State = {};
  for (const key of Object.keys(value)) {
    if (ignored.has(key) && !selected?.includes(key)) continue;
    check(hasOwn(baseline, key));
    const original: unknown = Reflect.get(value, key);
    const base: unknown = Reflect.get(baseline, key);
    if (selected ? selected.includes(key) : comparable(base) !== undefined) {
      const entry = comparable(original);
      const shape = comparable(base);
      check(
        entry !== undefined &&
          shape !== undefined &&
          (Array.isArray(shape)
            ? Array.isArray(entry) && shape.length === entry.length
            : shape === null
              ? entry === null ||
                (nullableEnums.has(key) && typeof entry === "number")
              : typeof entry === typeof shape),
      );
      if (Array.isArray(entry)) entry.forEach(finite);
      result[key] = entry;
    } else check(sameDefault(original, base));
  }
  return result;
}
const materialShape = {
  ...stateFrom(materialDefault, materialDefault, materialIgnored),
  alphaTest: 0,
};
const textureShape = stateFrom(textureDefault, textureDefault, textureIgnored);
const nodeShape = {
  ...stateFrom(nodeDefault, nodeDefault, nodeIgnored, nodeKeys),
  layers: 1,
  rotationOrder: "XYZ",
};
function validateState(
  value: unknown,
  shape: State,
  budget: Budget,
): asserts value is State {
  const record = keys(value, Object.keys(shape));
  cloneJson(record, budget);
  for (const [key, base] of Object.entries(shape)) {
    const entry = record[key];
    if (Array.isArray(base)) vector(entry, base.length);
    else if (base === null)
      check(
        entry === null ||
          (nullableEnums.has(key) &&
            typeof entry === "number" &&
            Number.isFinite(entry)),
      );
    else if (typeof base === "number") finite(entry);
    else if (typeof base === "string") text(entry);
    else check(typeof entry === "boolean");
    if (key.startsWith("is")) check(entry === base);
  }
}
function applyState(target: object, state: State) {
  for (const [key, value] of Object.entries(state)) {
    const original: unknown = Reflect.get(target, key);
    if (Array.isArray(value)) {
      if (original instanceof THREE.Color) {
        // These are exact working-space channels, not hex or an encoded color.
        original.r = value[0];
        original.g = value[1];
        original.b = value[2];
      } else if (
        original instanceof THREE.Vector2 ||
        original instanceof THREE.Vector3 ||
        original instanceof THREE.Quaternion ||
        original instanceof THREE.Matrix3 ||
        original instanceof THREE.Matrix4
      )
        original.fromArray(value);
      else throw new Error("Invalid reconstructed state shape");
    } else Reflect.set(target, key, value);
  }
}
function sourceValid(value: unknown): asserts value is ProcessedModelSource {
  const src = keys(value, ["byteLength", "sha256"]);
  integer(src.byteLength, 20, PROCESSED_MODEL_LIMITS.sourceBytes);
  check(typeof src.sha256 === "string" && /^[a-f0-9]{64}$/.test(src.sha256));
}

/** Only bytes whose entire dependency closure is inside this GLB authorize persistence. */
export async function identifyProcessedModelSource(
  bytes: ArrayBuffer,
): Promise<ProcessedModelSource | null> {
  try {
    integer(bytes.byteLength, 20, PROCESSED_MODEL_LIMITS.sourceBytes);
    const view = new DataView(bytes);
    check(
      view.getUint32(0, true) === 0x46546c67 &&
        view.getUint32(4, true) === 2 &&
        view.getUint32(8, true) === bytes.byteLength,
    );
    let offset = 12;
    let json: Record<string, unknown> | null = null;
    let binBytes = 0;
    while (offset < bytes.byteLength) {
      check(offset + 8 <= bytes.byteLength);
      const size = view.getUint32(offset, true),
        kind = view.getUint32(offset + 4, true);
      check(size % 4 === 0 && offset + 8 + size <= bytes.byteLength);
      if (offset === 12) {
        check(kind === 0x4e4f534a && size <= PROCESSED_MODEL_LIMITS.jsonBytes);
        json = object(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              new Uint8Array(bytes, offset + 8, size),
            ),
          ),
        );
      } else {
        check(kind === 0x004e4942 && binBytes === 0 && size > 0);
        binBytes = size;
      }
      offset += 8 + size;
    }
    check(json && object(json.asset).version === "2.0");
    const buffers = json.buffers ?? [];
    array(buffers, 1);
    for (const input of buffers) {
      const buffer = object(input);
      check(!hasOwn(buffer, "uri"));
      integer(buffer.byteLength, 1, binBytes);
      check(binBytes - buffer.byteLength < 4);
    }
    const images = json.images ?? [];
    array(images, PROCESSED_MODEL_LIMITS.sources);
    for (const input of images) {
      const image = object(input);
      check(!hasOwn(image, "uri"));
      integer(image.bufferView);
      check(typeof image.mimeType === "string");
    }
    // Unknown extensions may introduce external dependencies: admit only loader-supported,
    // embedded geometry/material extensions that do not define additional resource URIs.
    const extensions = json.extensionsUsed ?? [];
    array(extensions, 32);
    const embedded = new Set([
      "KHR_materials_unlit",
      "KHR_materials_ior",
      "KHR_materials_specular",
      "KHR_materials_clearcoat",
      "KHR_materials_transmission",
      "KHR_materials_volume",
      "KHR_materials_sheen",
      "KHR_materials_iridescence",
      "KHR_materials_anisotropy",
      "KHR_materials_emissive_strength",
      "KHR_texture_transform",
      "KHR_mesh_quantization",
      "EXT_meshopt_compression",
      "EXT_texture_webp",
    ]);
    check(
      extensions.every(
        (extension) => typeof extension === "string" && embedded.has(extension),
      ),
    );
    const required = json.extensionsRequired ?? [];
    array(required, 32);
    check(required.every((extension) => extensions.includes(extension)));
    let members = 0;
    const inspect = (input: unknown, depth: number) => {
      check(depth <= 32 && ++members <= 65536);
      if (input === null || typeof input !== "object") return;
      if (Array.isArray(input)) {
        input.forEach((child) => inspect(child, depth + 1));
        return;
      }
      for (const [key, entry] of Object.entries(object(input))) {
        check(key !== "uri");
        if (key === "extensions")
          check(
            Object.keys(object(entry)).every(
              (name) => embedded.has(name) && extensions.includes(name),
            ),
          );
        inspect(entry, depth + 1);
      }
    };
    inspect(json, 0);
    if (!globalThis.crypto?.subtle) return null;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Object.freeze({
      byteLength: bytes.byteLength,
      sha256: Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
    });
  } catch {
    return null;
  }
}

class Budget {
  bytes = 0;
  jsonBytes = 0;
  jsonEntries = 0;
  add(count: number) {
    integer(count);
    this.bytes += count;
    check(this.bytes <= PROCESSED_MODEL_LIMITS.payloadBytes);
  }
  json(bytes: number) {
    this.jsonBytes += bytes;
    check(
      ++this.jsonEntries <= 262144 &&
        this.jsonBytes <= PROCESSED_MODEL_LIMITS.jsonBytes,
    );
  }
}
function encodeAttribute(
  attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  budget: Budget,
): AttributeRecord {
  check(
    !(attr instanceof THREE.Float16BufferAttribute) &&
      !(attr instanceof THREE.InstancedBufferAttribute),
  );
  const interleaved = attr instanceof THREE.InterleavedBufferAttribute;
  if (interleaved)
    check(
      !(attr.data instanceof THREE.InstancedInterleavedBuffer) &&
        attr.data.onUploadCallback ===
          THREE.InterleavedBuffer.prototype.onUploadCallback &&
        attr.data.updateRanges.length === 0,
    );
  const source = interleaved ? attr.data.array : attr.array;
  const type = source.constructor.name;
  check(hasOwn(arrayTypes, type));
  const Constructor = arrayTypes[type as keyof typeof arrayTypes];
  integer(attr.itemSize, 1, 4);
  integer(attr.count, 1);
  budget.json(attr.name.length * 2 + 64);
  budget.add(attr.count * attr.itemSize * source.BYTES_PER_ELEMENT);
  const raw = new Constructor(attr.count * attr.itemSize);
  if (interleaved) {
    for (let i = 0; i < attr.count; i++)
      for (let j = 0; j < attr.itemSize; j++)
        raw[i * attr.itemSize + j] =
          source[i * attr.data.stride + attr.offset + j];
  } else {
    check(
      attr.onUploadCallback === attributeDefault.onUploadCallback &&
        attr.updateRanges.length === 0,
    );
    raw.set(source);
  }
  for (const component of raw) finite(component);
  return {
    type,
    data: raw.buffer,
    itemSize: attr.itemSize,
    normalized: attr.normalized,
    name: attr.name,
    usage: interleaved ? attr.data.usage : attr.usage,
    gpuType: interleaved ? THREE.FloatType : attr.gpuType,
  };
}

/** Returns null for the whole scene, never a partially stripped approximation. */
export function encodeProcessedModel(
  url: string,
  source: ProcessedModelSource,
  scene: THREE.Object3D,
  animations: readonly THREE.AnimationClip[],
  collision?: ModelCollisionData,
): ProcessedModelRecord | null {
  try {
    sourceValid(source);
    text(url);
    check(animations.length === 0);
    const budget = new Budget();
    const record: ProcessedModelRecord = {
      version: PROCESSED_MODEL_VERSION,
      policy: POLICY,
      url,
      source: { ...source },
      sources: [],
      textures: [],
      materials: [],
      geometries: [],
      nodes: [],
      collision: collision ? structuredClone(collision) : null,
    };
    const sources = new Map<THREE.Texture["source"], number>();
    const textures = new Map<THREE.Texture, number>();
    const materials = new Map<THREE.Material, number>();
    const geometries = new Map<THREE.BufferGeometry, number>();
    function textureId(texture: THREE.Texture): number {
      const known = textures.get(texture);
      if (known !== undefined) return known;
      check(
        Object.getPrototypeOf(texture) === THREE.DataTexture.prototype &&
          record.textures.length < PROCESSED_MODEL_LIMITS.textures,
      );
      check(
        texture.type === THREE.UnsignedByteType &&
          texture.format === THREE.RGBAFormat &&
          texture.mapping === THREE.UVMapping &&
          texture.source.dataReady,
      );
      const state = stateFrom(texture, textureDefault, textureIgnored);
      let id = sources.get(texture.source);
      if (id === undefined) {
        check(record.sources.length < PROCESSED_MODEL_LIMITS.sources);
        const data: unknown = texture.source.data;
        const image = keys(data, ["data", "width", "height"]);
        integer(image.width, 1, PROCESSED_MODEL_LIMITS.dimension);
        integer(image.height, 1, PROCESSED_MODEL_LIMITS.dimension);
        const pixels = image.data;
        check(
          pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray,
        );
        check(pixels.byteLength === image.width * image.height * 4);
        budget.add(pixels.byteLength);
        id = record.sources.length;
        sources.set(texture.source, id);
        record.sources.push({
          width: image.width,
          height: image.height,
          pixels: new Uint8Array(pixels).buffer,
          clamped: pixels instanceof Uint8ClampedArray,
        });
      }
      const index = record.textures.length;
      textures.set(texture, index);
      record.textures.push({
        source: id,
        state,
        userData: cloneExtras(texture.userData, budget),
      });
      return index;
    }
    function materialId(material: THREE.Material): number {
      const known = materials.get(material);
      if (known !== undefined) return known;
      check(
        Object.getPrototypeOf(material) ===
          MeshStandardNodeMaterial.prototype &&
          record.materials.length < PROCESSED_MODEL_LIMITS.materials,
      );
      check(
        material.onBeforeRender === materialDefault.onBeforeRender &&
          material.onBeforeCompile === materialDefault.onBeforeCompile &&
          material.customProgramCacheKey ===
            materialDefault.customProgramCacheKey,
      );
      const state = {
        ...stateFrom(material, materialDefault, materialIgnored),
        alphaTest: material.alphaTest,
      };
      const maps: Record<string, number | null> = {};
      for (const key of mapKeys) {
        const texture: unknown = Reflect.get(material, key);
        check(texture === null || texture instanceof THREE.Texture);
        maps[key] = texture ? textureId(texture) : null;
      }
      const index = record.materials.length;
      materials.set(material, index);
      record.materials.push({
        state,
        maps,
        userData: cloneExtras(material.userData, budget),
      });
      return index;
    }
    function geometryId(geometry: THREE.BufferGeometry): number {
      const known = geometries.get(geometry);
      if (known !== undefined) return known;
      check(Object.getPrototypeOf(geometry) === THREE.BufferGeometry.prototype);
      const preserved = new Set([
        "uuid",
        "name",
        "attributes",
        "index",
        "groups",
        "drawRange",
        "boundingBox",
        "boundingSphere",
        "userData",
        "_listeners",
        "_transformed",
      ]);
      for (const key of Object.keys(geometry))
        if (!preserved.has(key))
          check(
            hasOwn(geometryDefault, key) &&
              sameDefault(
                Reflect.get(geometry, key),
                Reflect.get(geometryDefault, key),
              ),
          );
      check(
        record.geometries.length < PROCESSED_MODEL_LIMITS.geometries &&
          !geometry.indirect &&
          geometry.indirectOffset === 0 &&
          Object.keys(geometry.morphAttributes).length === 0 &&
          !geometry.morphTargetsRelative,
      );
      check(
        geometry.getAttribute("position") &&
          Object.keys(geometry.attributes).length <= attributeNames.size,
      );
      const attributes: Record<string, AttributeRecord> = {};
      array(geometry.groups, 4096);
      cloneJson(geometry.groups, budget);
      for (const [key, attr] of Object.entries(geometry.attributes)) {
        check(
          attributeNames.has(key) &&
            (attr instanceof THREE.BufferAttribute ||
              attr instanceof THREE.InterleavedBufferAttribute),
        );
        attributes[key] = encodeAttribute(attr, budget);
      }
      const index = record.geometries.length;
      geometries.set(geometry, index);
      record.geometries.push({
        name: geometry.name,
        attributes,
        index: geometry.index ? encodeAttribute(geometry.index, budget) : null,
        groups: geometry.groups.map((group) => ({
          start: group.start,
          count: group.count,
          materialIndex: group.materialIndex ?? 0,
        })),
        drawRange: {
          start: geometry.drawRange.start,
          count:
            geometry.drawRange.count === Infinity
              ? null
              : geometry.drawRange.count,
        },
        boundingBox: geometry.boundingBox
          ? [
              ...geometry.boundingBox.min.toArray(),
              ...geometry.boundingBox.max.toArray(),
            ]
          : null,
        boundingSphere: geometry.boundingSphere
          ? [
              ...geometry.boundingSphere.center.toArray(),
              geometry.boundingSphere.radius,
            ]
          : null,
        userData: cloneExtras(geometry.userData, budget),
      });
      return index;
    }
    const visited = new Set<THREE.Object3D>();
    function nodeId(node: THREE.Object3D, depth: number): number {
      check(
        depth <= PROCESSED_MODEL_LIMITS.depth &&
          !visited.has(node) &&
          record.nodes.length < PROCESSED_MODEL_LIMITS.nodes,
      );
      visited.add(node);
      const mesh = node instanceof THREE.Mesh;
      check(
        node.constructor === THREE.Object3D ||
          node.constructor === THREE.Group ||
          node.constructor === THREE.Mesh,
      );
      check(
        node.animations.length === 0 &&
          !node.customDepthMaterial &&
          !node.customDistanceMaterial,
      );
      check(
        node.onBeforeRender === nodeDefault.onBeforeRender &&
          node.onAfterRender === nodeDefault.onAfterRender &&
          node.onBeforeShadow === nodeDefault.onBeforeShadow &&
          node.onAfterShadow === nodeDefault.onAfterShadow,
      );
      const baseline = mesh
        ? new THREE.Mesh(geometryDefault, materialDefault)
        : node instanceof THREE.Group
          ? new THREE.Group()
          : nodeDefault;
      const state = {
        ...stateFrom(node, baseline, nodeIgnored, nodeKeys),
        layers: node.layers.mask,
        rotationOrder: node.rotation.order,
      };
      const index = record.nodes.length;
      record.nodes.push({
        kind: mesh
          ? "Mesh"
          : node instanceof THREE.Group
            ? "Group"
            : "Object3D",
        state,
        userData: cloneExtras(node.userData, budget),
        geometry: mesh ? geometryId(node.geometry) : null,
        materials: mesh
          ? (Array.isArray(node.material)
              ? node.material
              : [node.material]
            ).map(materialId)
          : null,
        materialArray: mesh && Array.isArray(node.material),
        children: [],
      });
      record.nodes[index].children = node.children.map((child) =>
        nodeId(child, depth + 1),
      );
      return index;
    }
    nodeId(scene, 0);
    validateRecord(record, url, source);
    return record;
  } catch {
    return null;
  }
}

function validateRecord(
  value: unknown,
  url: string,
  source: ProcessedModelSource,
): asserts value is ProcessedModelRecord {
  const r = keys(value, [
    "version",
    "policy",
    "url",
    "source",
    "sources",
    "textures",
    "materials",
    "geometries",
    "nodes",
    "collision",
  ]);
  check(
    r.version === PROCESSED_MODEL_VERSION &&
      r.policy === POLICY &&
      r.url === url,
  );
  text(r.url);
  sourceValid(r.source);
  sourceValid(source);
  check(
    r.source.byteLength === source.byteLength &&
      r.source.sha256 === source.sha256,
  );
  array(r.sources, PROCESSED_MODEL_LIMITS.sources);
  array(r.textures, PROCESSED_MODEL_LIMITS.textures);
  array(r.materials, PROCESSED_MODEL_LIMITS.materials);
  array(r.geometries, PROCESSED_MODEL_LIMITS.geometries);
  array(r.nodes, PROCESSED_MODEL_LIMITS.nodes);
  check(r.nodes.length > 0);
  const rawMaterials = r.materials,
    rawNodes = r.nodes;
  const budget = new Budget();
  const usedSources = new Set<number>(),
    usedTextures = new Set<number>(),
    usedMaterials = new Set<number>(),
    usedGeometries = new Set<number>();
  for (const input of r.sources) {
    const item = keys(input, ["width", "height", "pixels", "clamped"]);
    integer(item.width, 1, PROCESSED_MODEL_LIMITS.dimension);
    integer(item.height, 1, PROCESSED_MODEL_LIMITS.dimension);
    check(
      item.pixels instanceof ArrayBuffer &&
        item.pixels.byteLength === item.width * item.height * 4 &&
        typeof item.clamped === "boolean",
    );
    budget.add(item.pixels.byteLength);
  }
  for (const input of r.textures) {
    const item = keys(input, ["source", "state", "userData"]);
    integer(item.source, 0, r.sources.length - 1);
    usedSources.add(item.source);
    validateState(item.state, textureShape, budget);
    cloneExtras(item.userData, budget);
    const s = item.state;
    check(
      s.type === THREE.UnsignedByteType &&
        s.format === THREE.RGBAFormat &&
        s.mapping === THREE.UVMapping &&
        s.internalFormat === null &&
        s.isDataTexture === true &&
        s.isRenderTargetTexture === false &&
        s.isArrayTexture === false,
    );
    integer(s.channel, 0, 3);
    integer(s.anisotropy, 1, 16);
    check(
      oneOf(s.wrapS, [
        THREE.ClampToEdgeWrapping,
        THREE.RepeatWrapping,
        THREE.MirroredRepeatWrapping,
      ]) &&
        oneOf(s.wrapT, [
          THREE.ClampToEdgeWrapping,
          THREE.RepeatWrapping,
          THREE.MirroredRepeatWrapping,
        ]),
    );
    check(
      oneOf(s.magFilter, [THREE.NearestFilter, THREE.LinearFilter]) &&
        oneOf(s.minFilter, [1003, 1004, 1005, 1006, 1007, 1008]),
    );
    check(
      oneOf(s.unpackAlignment, [1, 2, 4, 8]) &&
        oneOf(s.colorSpace, [
          THREE.NoColorSpace,
          THREE.SRGBColorSpace,
          THREE.LinearSRGBColorSpace,
        ]),
    );
  }
  for (const input of r.materials) {
    const item = keys(input, ["state", "maps", "userData"]);
    validateState(item.state, materialShape, budget);
    const s = item.state;
    check(
      oneOf(s.side, [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide]) &&
        oneOf(s.shadowSide, [
          null,
          THREE.FrontSide,
          THREE.BackSide,
          THREE.DoubleSide,
        ]),
    );
    check(
      oneOf(s.blending, [
        THREE.NoBlending,
        THREE.NormalBlending,
        THREE.AdditiveBlending,
        THREE.SubtractiveBlending,
        THREE.MultiplyBlending,
        THREE.CustomBlending,
      ]),
    );
    const factors = [
      THREE.ZeroFactor,
      THREE.OneFactor,
      THREE.SrcColorFactor,
      THREE.OneMinusSrcColorFactor,
      THREE.SrcAlphaFactor,
      THREE.OneMinusSrcAlphaFactor,
      THREE.DstAlphaFactor,
      THREE.OneMinusDstAlphaFactor,
      THREE.DstColorFactor,
      THREE.OneMinusDstColorFactor,
      THREE.SrcAlphaSaturateFactor,
      THREE.ConstantColorFactor,
      THREE.OneMinusConstantColorFactor,
      THREE.ConstantAlphaFactor,
      THREE.OneMinusConstantAlphaFactor,
    ];
    check(
      oneOf(s.blendSrc, factors) &&
        oneOf(s.blendDst, factors) &&
        oneOf(s.blendSrcAlpha, [null, ...factors]) &&
        oneOf(s.blendDstAlpha, [null, ...factors]),
    );
    const equations = [
      THREE.AddEquation,
      THREE.SubtractEquation,
      THREE.ReverseSubtractEquation,
      THREE.MinEquation,
      THREE.MaxEquation,
    ];
    check(
      oneOf(s.blendEquation, equations) &&
        oneOf(s.blendEquationAlpha, [null, ...equations]),
    );
    check(
      oneOf(s.depthFunc, [
        THREE.NeverDepth,
        THREE.AlwaysDepth,
        THREE.LessDepth,
        THREE.LessEqualDepth,
        THREE.EqualDepth,
        THREE.GreaterEqualDepth,
        THREE.GreaterDepth,
        THREE.NotEqualDepth,
      ]) &&
        oneOf(s.normalMapType, [
          THREE.TangentSpaceNormalMap,
          THREE.ObjectSpaceNormalMap,
        ]),
    );
    check(
      oneOf(s.stencilFunc, [
        THREE.NeverStencilFunc,
        THREE.LessStencilFunc,
        THREE.EqualStencilFunc,
        THREE.LessEqualStencilFunc,
        THREE.GreaterStencilFunc,
        THREE.NotEqualStencilFunc,
        THREE.GreaterEqualStencilFunc,
        THREE.AlwaysStencilFunc,
      ]),
    );
    const stencilOps = [
      THREE.ZeroStencilOp,
      THREE.KeepStencilOp,
      THREE.ReplaceStencilOp,
      THREE.IncrementStencilOp,
      THREE.DecrementStencilOp,
      THREE.InvertStencilOp,
      THREE.IncrementWrapStencilOp,
      THREE.DecrementWrapStencilOp,
    ];
    for (const key of ["stencilFail", "stencilZFail", "stencilZPass"])
      check(oneOf(s[key], stencilOps));
    for (const key of ["stencilRef", "stencilWriteMask", "stencilFuncMask"])
      integer(s[key], 0, 255);
    check(
      oneOf(s.wireframeLinecap, ["butt", "round", "square"]) &&
        oneOf(s.wireframeLinejoin, ["round", "bevel", "miter"]),
    );
    cloneExtras(item.userData, budget);
    const maps = keys(item.maps, mapKeys);
    for (const id of Object.values(maps))
      if (id !== null) {
        integer(id, 0, r.textures.length - 1);
        usedTextures.add(id);
      }
  }
  function attribute(input: unknown): { count: number; itemSize: number } {
    const a = keys(input, [
      "type",
      "data",
      "itemSize",
      "normalized",
      "name",
      "usage",
      "gpuType",
    ]);
    check(typeof a.type === "string" && hasOwn(arrayTypes, a.type));
    check(a.data instanceof ArrayBuffer);
    integer(a.itemSize, 1, 4);
    text(a.name);
    budget.json(a.name.length * 2 + 64);
    check(typeof a.normalized === "boolean");
    check(
      oneOf(a.usage, [
        THREE.StaticDrawUsage,
        THREE.DynamicDrawUsage,
        THREE.StreamDrawUsage,
      ]) && oneOf(a.gpuType, [THREE.FloatType, THREE.IntType]),
    );
    const Constructor = arrayTypes[a.type as keyof typeof arrayTypes];
    const count =
      a.data.byteLength / Constructor.BYTES_PER_ELEMENT / a.itemSize;
    integer(count, 1);
    budget.add(a.data.byteLength);
    for (const component of new Constructor(a.data)) finite(component);
    return { count, itemSize: a.itemSize };
  }
  for (const input of r.geometries) {
    const g = keys(input, [
      "name",
      "attributes",
      "index",
      "groups",
      "drawRange",
      "boundingBox",
      "boundingSphere",
      "userData",
    ]);
    text(g.name);
    budget.json(g.name.length * 2);
    cloneExtras(g.userData, budget);
    if (g.boundingBox !== null) {
      vector(g.boundingBox, 6);
      const box = g.boundingBox as number[];
      for (let i = 0; i < 3; i++) check(box[i] <= box[i + 3]);
    }
    if (g.boundingSphere !== null) {
      vector(g.boundingSphere, 4);
      check((g.boundingSphere as number[])[3] >= 0);
    }
    const attrs = object(g.attributes);
    check(
      hasOwn(attrs, "position") &&
        Object.keys(attrs).length <= attributeNames.size,
    );
    const position = attribute(attrs.position);
    check(position.itemSize === 3);
    for (const [name, input] of Object.entries(attrs)) {
      check(attributeNames.has(name));
      if (name !== "position") {
        const a = attribute(input);
        check(
          a.count === position.count &&
            a.itemSize ===
              (name === "normal"
                ? 3
                : name === "tangent"
                  ? 4
                  : name === "color"
                    ? a.itemSize
                    : 2) &&
            (name !== "color" || a.itemSize === 3 || a.itemSize === 4),
        );
      }
    }
    let count = position.count;
    if (g.index !== null) {
      const a = attribute(g.index),
        index = object(g.index);
      check(
        a.itemSize === 1 &&
          !index.normalized &&
          ["Uint8Array", "Uint16Array", "Uint32Array"].includes(
            String(index.type),
          ),
      );
      count = a.count;
      const Constructor = arrayTypes[index.type as keyof typeof arrayTypes];
      for (const i of new Constructor(index.data as ArrayBuffer))
        integer(i, 0, position.count - 1);
    }
    array(g.groups, 4096);
    cloneJson(g.groups, budget);
    for (const input of g.groups) {
      const group = keys(input, ["start", "count", "materialIndex"]);
      integer(group.start, 0, count);
      integer(group.count, 0, count - group.start);
      integer(group.materialIndex, 0, PROCESSED_MODEL_LIMITS.materials - 1);
    }
    const range = keys(g.drawRange, ["start", "count"]);
    integer(range.start, 0, count);
    if (range.count !== null) integer(range.count, 0, count - range.start);
  }
  const parents = new Uint8Array(r.nodes.length);
  for (const input of r.nodes) {
    const n = keys(input, [
      "kind",
      "state",
      "userData",
      "geometry",
      "materials",
      "materialArray",
      "children",
    ]);
    check(["Object3D", "Group", "Mesh"].includes(String(n.kind)));
    validateState(n.state, nodeShape, budget);
    cloneExtras(n.userData, budget);
    integer(n.state.layers, -2147483648, 4294967295);
    check(
      ["XYZ", "YXZ", "ZXY", "ZYX", "YZX", "XZY"].includes(
        String(n.state.rotationOrder),
      ),
    );
    check(typeof n.materialArray === "boolean");
    if (n.kind === "Mesh") {
      integer(n.geometry, 0, r.geometries.length - 1);
      usedGeometries.add(n.geometry);
      array(n.materials, PROCESSED_MODEL_LIMITS.materials);
      check(
        n.materials.length > 0 && (n.materialArray || n.materials.length === 1),
      );
      n.materials.forEach((id) => {
        integer(id, 0, rawMaterials.length - 1);
        usedMaterials.add(id);
      });
      const geometry = object(r.geometries[n.geometry]);
      if (n.materialArray)
        for (const group of geometry.groups as { materialIndex: number }[])
          check(group.materialIndex < n.materials.length);
      // All sampled UV channels must actually exist on each consuming geometry.
      for (const id of n.materials)
        for (const textureId of Object.values(
          object(object(r.materials[id as number]).maps),
        ))
          if (textureId !== null) {
            const channel = object(
              object(r.textures[textureId as number]).state,
            ).channel;
            check(
              hasOwn(
                object(geometry.attributes),
                channel === 0 ? "uv" : `uv${channel}`,
              ),
            );
          }
    } else
      check(
        n.geometry === null &&
          n.materials === null &&
          n.materialArray === false,
      );
    array(n.children, PROCESSED_MODEL_LIMITS.nodes);
    for (const id of n.children) {
      integer(id, 1, r.nodes.length - 1);
      check(++parents[id] === 1);
    }
  }
  for (let i = 1; i < parents.length; i++) check(parents[i] === 1);
  const seen = new Set<number>();
  const walk = (index: number, depth: number) => {
    check(depth <= PROCESSED_MODEL_LIMITS.depth && !seen.has(index));
    seen.add(index);
    const n = object(rawNodes[index]);
    for (const child of n.children as number[]) walk(child, depth + 1);
  };
  walk(0, 0);
  check(seen.size === r.nodes.length);
  check(
    usedSources.size === r.sources.length &&
      usedTextures.size === r.textures.length &&
      usedMaterials.size === r.materials.length &&
      usedGeometries.size === r.geometries.length,
  );
  if (r.collision !== null) {
    const c = keys(r.collision, ["footprint", "bounds", "dimensions"]);
    const footprint = keys(c.footprint, ["width", "depth"]);
    for (const value of Object.values(footprint)) {
      finite(value);
      check(value > 0);
    }
    const bounds = keys(c.bounds, ["min", "max"]);
    const min = keys(bounds.min, ["x", "y", "z"]),
      max = keys(bounds.max, ["x", "y", "z"]),
      dims = keys(c.dimensions, ["x", "y", "z"]);
    for (const key of ["x", "y", "z"]) {
      finite(min[key]);
      finite(max[key]);
      finite(dims[key]);
      check(Number(max[key]) >= Number(min[key]) && Number(dims[key]) >= 0);
    }
  }
}

export function decodeProcessedModel(
  value: unknown,
  url: string,
  source: ProcessedModelSource,
  setupMaterial?: (material: MeshStandardNodeMaterial) => void,
): {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
  collision?: ModelCollisionData;
} | null {
  const textures: THREE.DataTexture[] = [],
    materials: MeshStandardNodeMaterial[] = [],
    geometries: THREE.BufferGeometry[] = [];
  try {
    validateRecord(value, url, source);
    // No THREE allocation until the complete record has passed admission.
    const sources = value.sources.map(
      (s) =>
        new THREE.TextureSource({
          width: s.width,
          height: s.height,
          data: s.clamped
            ? new Uint8ClampedArray(s.pixels.slice(0))
            : new Uint8Array(s.pixels.slice(0)),
        }),
    );
    for (const stored of value.textures) {
      const texture = new THREE.DataTexture();
      textures.push(texture);
      texture.source = sources[stored.source];
      applyState(texture, stored.state);
      texture.userData = cloneExtras(stored.userData);
      texture.needsUpdate = true;
    }
    for (const stored of value.materials) {
      const material = new MeshStandardNodeMaterial();
      materials.push(material);
      applyState(material, stored.state);
      for (const key of mapKeys) {
        const id = stored.maps[key];
        material[key] = id === null ? null : textures[id];
      }
      material.userData = cloneExtras(stored.userData);
      material.needsUpdate = true;
    }
    const attr = (a: AttributeRecord) => {
      const Constructor = arrayTypes[a.type as keyof typeof arrayTypes];
      const result = new THREE.BufferAttribute(
        new Constructor(a.data.slice(0)),
        a.itemSize,
        a.normalized,
      );
      result.name = a.name;
      result.setUsage(a.usage as THREE.Usage);
      result.gpuType = a.gpuType as THREE.AttributeGPUType;
      return result;
    };
    for (const stored of value.geometries) {
      const geometry = new THREE.BufferGeometry();
      geometries.push(geometry);
      geometry.name = stored.name;
      for (const [name, a] of Object.entries(stored.attributes))
        geometry.setAttribute(name, attr(a));
      if (stored.index) geometry.setIndex(attr(stored.index));
      for (const group of stored.groups)
        geometry.addGroup(group.start, group.count, group.materialIndex);
      geometry.setDrawRange(
        stored.drawRange.start,
        stored.drawRange.count ?? Infinity,
      );
      geometry.userData = cloneExtras(stored.userData);
      if (stored.boundingBox)
        geometry.boundingBox = new THREE.Box3(
          new THREE.Vector3().fromArray(stored.boundingBox),
          new THREE.Vector3().fromArray(stored.boundingBox, 3),
        );
      if (stored.boundingSphere)
        geometry.boundingSphere = new THREE.Sphere(
          new THREE.Vector3().fromArray(stored.boundingSphere),
          stored.boundingSphere[3],
        );
    }
    const nodes = value.nodes.map((stored) => {
      const node =
        stored.kind === "Mesh"
          ? new THREE.Mesh(
              geometries[stored.geometry!],
              stored.materialArray
                ? stored.materials!.map((id) => materials[id])
                : materials[stored.materials![0]],
            )
          : stored.kind === "Group"
            ? new THREE.Group()
            : new THREE.Object3D();
      const { layers, rotationOrder, ...state } = stored.state;
      node.rotation.order = rotationOrder as THREE.EulerOrder;
      applyState(node, state);
      node.layers.mask = layers as number;
      node.userData = cloneExtras(stored.userData);
      return node;
    });
    value.nodes.forEach((stored, index) =>
      stored.children.forEach((child) => nodes[index].add(nodes[child])),
    );
    for (const material of materials) setupMaterial?.(material);
    return {
      scene: nodes[0],
      animations: [],
      ...(value.collision
        ? { collision: structuredClone(value.collision) }
        : {}),
    };
  } catch {
    // These are exclusively new objects, never the source scene or a live cache clone.
    // Continue cleanup if a consumer's dispose listener itself throws.
    for (const owned of [...geometries, ...materials, ...textures]) {
      try {
        owned.dispose();
      } catch {
        /* isolate teardown listeners */
      }
    }
    return null;
  }
}
