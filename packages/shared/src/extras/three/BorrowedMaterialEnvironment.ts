import {
  CubeUVReflectionMapping,
  Material,
  type MeshStandardMaterial,
  type MeshStandardNodeMaterial,
  type Texture,
} from "./three";

type PBRMaterial = MeshStandardMaterial | MeshStandardNodeMaterial;
const owners = new WeakMap<Material, BorrowedMaterialEnvironment>();
const needsUpdateSetter = Object.getOwnPropertyDescriptor(
  Material.prototype,
  "needsUpdate",
)?.set;
const descriptorKeys = [
  "value",
  "get",
  "set",
  "writable",
  "enumerable",
  "configurable",
] as const;
const sameDescriptor = (a?: PropertyDescriptor, b?: PropertyDescriptor) =>
  a === b ||
  (!!a && !!b && descriptorKeys.every((key) => Object.is(a[key], b[key])));
function inheritedDescriptor(
  object: object,
  key: string,
): PropertyDescriptor | undefined {
  for (
    let current: object | null = object;
    current;
    current = Object.getPrototypeOf(current)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return descriptor;
  }
}
function dataField(material: Material, key: string): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(material, key);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !descriptor.writable ||
    !descriptor.configurable
  )
    throw new Error(`Writable own data field required: ${key}`);
  return descriptor;
}
function validateUpdate(material: Material): void {
  if (
    inheritedDescriptor(material, "needsUpdate")?.set !== needsUpdateSetter ||
    !Number.isFinite(dataField(material, "version").value)
  )
    throw new Error("Unmodified Three material update setter required");
}
function validateIntensity(value: number): void {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError("Finite nonnegative intensity required");
}
type Binding = {
  material: PBRMaterial;
  envMap: PropertyDescriptor;
  intensity: PropertyDescriptor;
  cache: PropertyDescriptor | undefined;
  installedCache: PropertyDescriptor;
  envNode: PropertyDescriptor | undefined;
};

/**
 * Caller supplies genuine, unique, PRIVATE PBR materials and an already-qualified
 * borrowed PMREM. This class owns only their reversible environment bindings:
 * no texture/material disposal, cloning, scene mutation, loading or day/night policy.
 * Dispose before retiring the materials or releasing the caller's texture lease.
 */
export class BorrowedMaterialEnvironment {
  private readonly bindings: Binding[];
  private currentIntensity: number;
  private disposed = false;

  constructor(
    materials: readonly Material[],
    private readonly environmentMap: Texture,
    intensity: number,
  ) {
    validateIntensity(intensity);
    if (
      !environmentMap?.isTexture ||
      !("isPMREMTexture" in environmentMap) ||
      environmentMap.isPMREMTexture !== true ||
      environmentMap.mapping !== CubeUVReflectionMapping
    )
      throw new TypeError("Borrowed CubeUV PMREM texture required");
    if (!materials.length || new Set(materials).size !== materials.length)
      throw new Error("Nonempty, unique private material list required");
    // Complete preflight before any material is changed; no callbacks are invoked.
    this.bindings = materials.map((material) => {
      const pbr = material as PBRMaterial;
      if (
        !(material instanceof Material) ||
        (!(
          "isMeshStandardMaterial" in pbr && pbr.isMeshStandardMaterial === true
        ) &&
          !(
            "isMeshStandardNodeMaterial" in pbr &&
            pbr.isMeshStandardNodeMaterial === true
          ))
      )
        throw new TypeError("Standard/Physical PBR material required");
      if (owners.has(material))
        throw new Error("Material environment already owned");
      const envNode = inheritedDescriptor(material, "envNode");
      if (envNode && (!("value" in envNode) || envNode.value != null))
        throw new Error("Custom envNode unsupported");
      const cache = Object.getOwnPropertyDescriptor(
        material,
        "customProgramCacheKey",
      );
      const effectiveCache = inheritedDescriptor(
        material,
        "customProgramCacheKey",
      );
      if (
        !effectiveCache ||
        !("value" in effectiveCache) ||
        typeof effectiveCache.value !== "function" ||
        (cache ? !cache.configurable : !Object.isExtensible(material))
      )
        throw new Error("Restorable data-function cache key required");
      validateUpdate(material);
      const originalKey =
        effectiveCache.value as Material["customProgramCacheKey"];
      const installedCache: PropertyDescriptor = {
        value: function (this: Material) {
          return `${originalKey.call(this)}:borrowed-environment:${environmentMap.uuid}`;
        },
        configurable: true,
        writable: true,
        enumerable: cache?.enumerable ?? true,
      };
      return {
        material: pbr,
        envMap: dataField(material, "envMap"),
        intensity: dataField(material, "envMapIntensity"),
        cache,
        installedCache,
        envNode,
      };
    });
    this.currentIntensity = intensity;
    for (const row of this.bindings) {
      Object.defineProperties(row.material, {
        envMap: { ...row.envMap, value: environmentMap },
        envMapIntensity: { ...row.intensity, value: intensity },
        customProgramCacheKey: row.installedCache,
      });
      owners.set(row.material, this);
      row.material.needsUpdate = true;
    }
  }

  get active(): boolean {
    return !this.disposed;
  }
  get materialCount(): number {
    return this.bindings.length;
  }

  private validateOwnership(): void {
    for (const row of this.bindings) {
      if (
        owners.get(row.material) !== this ||
        !sameDescriptor(
          Object.getOwnPropertyDescriptor(row.material, "envMap"),
          { ...row.envMap, value: this.environmentMap },
        ) ||
        !sameDescriptor(
          Object.getOwnPropertyDescriptor(row.material, "envMapIntensity"),
          { ...row.intensity, value: this.currentIntensity },
        ) ||
        !sameDescriptor(
          Object.getOwnPropertyDescriptor(
            row.material,
            "customProgramCacheKey",
          ),
          row.installedCache,
        ) ||
        !sameDescriptor(
          inheritedDescriptor(row.material, "envNode"),
          row.envNode,
        )
      )
        throw new Error(
          "Material environment ownership changed; no fields restored or updated",
        );
      validateUpdate(row.material);
    }
  }

  updateIntensity(value: number): void {
    if (this.disposed) throw new Error("Material environment disposed");
    validateIntensity(value);
    this.validateOwnership();
    for (const row of this.bindings) row.material.envMapIntensity = value;
    this.currentIntensity = value; // Uniform-only: do not set needsUpdate.
  }

  dispose(): void {
    if (this.disposed) return;
    this.validateOwnership(); // A failed preflight retains all fields and retry authority.
    for (const row of this.bindings) {
      Object.defineProperties(row.material, {
        envMap: row.envMap,
        envMapIntensity: row.intensity,
      });
      if (row.cache)
        Object.defineProperty(row.material, "customProgramCacheKey", row.cache);
      else Reflect.deleteProperty(row.material, "customProgramCacheKey");
      row.material.needsUpdate = true;
      owners.delete(row.material);
    }
    this.disposed = true;
  }
}
