import {
  serializeWorldTerrainProfile,
  type WorldTerrainProfile,
} from "../systems/shared/world/WorldTerrainProfile";

/** Content used for world placement/grounding, not the entire gameplay/code closure. */
export const WORLD_IDENTITY_MANIFESTS = [
  "world-config.json",
  "world-areas.json",
  "buildings.json",
  "biomes.json",
  "npcs.json",
  "stations.json",
  "model-bounds.json",
  "gathering/woodcutting.json",
  "gathering/mining.json",
  "gathering/fishing.json",
  "duel-arenas.json",
] as const;

export const WORLD_IDENTITY_MAX_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 200_000;
const encoder = new TextEncoder();

/** Canonical JSON data only: stable keys, ordered arrays, no accessors/coercion. */
export function canonicalWorldJson(input: unknown): string {
  let nodes = 0;
  let bytes = 0;
  const chunks: string[] = [];
  const emit = (chunk: string): void => {
    bytes += encoder.encode(chunk).byteLength;
    if (bytes > WORLD_IDENTITY_MAX_BYTES)
      throw new Error("World identity data exceeds byte budget");
    chunks.push(chunk);
  };
  const quoted = (value: string): void => {
    if (value.length > WORLD_IDENTITY_MAX_BYTES)
      throw new Error("World identity data exceeds byte budget");
    emit(JSON.stringify(value));
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > 64)
      throw new Error("World identity data exceeds structural bounds");
    if (typeof value === "string") {
      quoted(value);
      return;
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      emit(JSON.stringify(value));
      return;
    }
    if (Array.isArray(value)) {
      const length = Object.getOwnPropertyDescriptor(value, "length")!
        .value as number;
      if (length > MAX_NODES)
        throw new Error("World identity data exceeds structural bounds");
      const descriptors = Object.getOwnPropertyDescriptors(
        value,
      ) as unknown as Record<string, PropertyDescriptor>;
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        length > MAX_NODES ||
        Reflect.ownKeys(value).length !== length + 1
      )
        throw new Error(
          "World identity requires dense JSON arrays without extra keys",
        );
      emit("[");
      for (let i = 0; i < length; i++) {
        const entry = descriptors[String(i)];
        if (!entry || !("value" in entry) || !entry.enumerable)
          throw new Error("World identity rejects sparse arrays and accessors");
        if (i) emit(",");
        visit(entry.value, depth + 1);
      }
      emit("]");
      return;
    }
    if (value && typeof value === "object") {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error("World identity requires plain JSON objects");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors);
      if (
        keys.length > MAX_NODES ||
        Reflect.ownKeys(value).length !== keys.length ||
        Object.values(descriptors).some(
          (entry) => !("value" in entry) || !entry.enumerable,
        )
      )
        throw new Error(
          "World identity rejects symbols, accessors and hidden keys",
        );
      emit("{");
      keys.sort().forEach((key, index) => {
        if (index) emit(",");
        quoted(key);
        emit(":");
        visit(descriptors[key].value, depth + 1);
      });
      emit("}");
      return;
    }
    throw new Error("World identity requires finite JSON values");
  };
  visit(input, 0);
  return chunks.join("");
}

export class WorldManifestIdentityBuilder {
  private readonly manifests = new Map<string, string>();
  private payloadBytes = encoder.encode("hyperia-world-content-v1\n")
    .byteLength;

  record(name: string, value: unknown): void {
    if (!(WORLD_IDENTITY_MANIFESTS as readonly string[]).includes(name))
      throw new Error(`Unsupported world identity manifest: ${name}`);
    const canonical = canonicalWorldJson(value);
    const previous = this.manifests.get(name);
    if (previous !== undefined && previous !== canonical)
      throw new Error(`World manifest changed during initialization: ${name}`);
    if (previous !== undefined) return;
    const bytes = encoder.encode(
      `${JSON.stringify(name)}:${canonical}\n`,
    ).byteLength;
    if (this.payloadBytes + bytes > WORLD_IDENTITY_MAX_BYTES)
      throw new Error("Combined world identity payload exceeds byte budget");
    this.payloadBytes += bytes;
    this.manifests.set(name, canonical);
  }

  async build(profile: WorldTerrainProfile): Promise<string> {
    const missing = WORLD_IDENTITY_MANIFESTS.filter(
      (name) => !this.manifests.has(name),
    );
    if (missing.length)
      throw new Error(
        `World identity requires loaded manifests: ${missing.join(", ")}`,
      );
    const config = JSON.parse(this.manifests.get("world-config.json")!) as {
      terrainProfile?: unknown;
    };
    if (
      canonicalWorldJson(config.terrainProfile) !==
      canonicalWorldJson(JSON.parse(serializeWorldTerrainProfile(profile)))
    )
      throw new Error(
        "World identity profile differs from loaded world-config.json",
      );
    const payload = `hyperia-world-content-v1\n${WORLD_IDENTITY_MANIFESTS.map((name) => `${JSON.stringify(name)}:${this.manifests.get(name)}`).join("\n")}`;
    const encoded = encoder.encode(payload);
    if (encoded.byteLength > WORLD_IDENTITY_MAX_BYTES)
      throw new Error("Combined world identity payload exceeds byte budget");
    if (!globalThis.crypto?.subtle)
      throw new Error("World identity requires Web Crypto SHA-256");
    const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
}
