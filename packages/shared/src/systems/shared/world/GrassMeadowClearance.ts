import type {
  GrassBladeGroundingDependency,
  GrassBladeGroundingResult,
} from "./GrassBladeGrounding";
import type { GrassAnchorData } from "./GrassTerrainProjection";

const BLADES = 21;
const ROOT_WORDS = BLADES * 2;
const ALL_BLADES = (1 << BLADES) - 1;
const MAX_BATCH = 128;
const FIELDS = [
  ["offsets", 3],
  ["rotScaleHash", 3],
  ["groundNormals", 3],
  ["groundColors", 3],
  ["grassTints", 4],
] as const;

export type GrassMeadowInstalledBatch = Readonly<{
  /** Small owner ordinal and generation, not a repeated terrain profile blob. */
  owner: number;
  generation: number;
  data: GrassAnchorData;
  rootDeltas: Float32Array;
  bladeVisibility?: Uint32Array;
}>;

type ReadyGrounding = Extract<GrassBladeGroundingResult, { status: "ready" }>;

/** Permission to replace only these exact installed rows. Deliberately does
 * not return the fitter's arrays: installation must retain the original data,
 * corrections and visibility, including blades hidden before certification. */
export type GrassMeadowClearanceCertificate = Readonly<{
  kind: "meadow-authored-clearance-v1";
  owner: number;
  generation: number;
  sourceIndices: Uint32Array;
  bladeVisibility: Uint32Array;
  /** Conservative union may also contain rows rejected by exact-word checks. */
  sweptBounds: ReadyGrounding["sweptBounds"];
  dependencies: readonly GrassBladeGroundingDependency[];
}>;

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function validateFloats(value: Float32Array, length: number): void {
  requireValue(
    value instanceof Float32Array &&
      value.buffer instanceof ArrayBuffer &&
      value.length === length &&
      value.every(Number.isFinite),
    "Invalid meadow installed float array",
  );
}

function validateData(data: GrassAnchorData): void {
  requireValue(
    Number.isSafeInteger(data.count) &&
      data.count >= 0 &&
      data.count <= MAX_BATCH,
    "Invalid meadow installed batch capacity",
  );
  for (const [field, stride] of FIELDS)
    validateFloats(data[field], data.count * stride);
}

function validateMask(mask: Uint32Array | undefined, count: number): void {
  if (mask === undefined) return;
  requireValue(
    mask instanceof Uint32Array &&
      mask.buffer instanceof ArrayBuffer &&
      mask.length === count &&
      mask.every((value) => value !== 0 && (value & ALL_BLADES) === value),
    "Invalid meadow installed blade visibility",
  );
}

/** Capture one detached, bounded baseline before starting the shared grounding
 * continuation. The owner keeps this snapshot private and must lease the live
 * source arrays/generation separately; this copy is not itself a live lease. */
export function captureGrassMeadowInstalledBatch(
  input: GrassMeadowInstalledBatch,
): GrassMeadowInstalledBatch {
  requireValue(
    Number.isSafeInteger(input.owner) &&
      input.owner >= 0 &&
      Number.isSafeInteger(input.generation) &&
      input.generation >= 0,
    "Invalid meadow installed owner identity",
  );
  validateData(input.data);
  validateFloats(input.rootDeltas, input.data.count * ROOT_WORDS);
  validateMask(input.bladeVisibility, input.data.count);
  const data = { count: input.data.count } as GrassAnchorData;
  for (const [field] of FIELDS) data[field] = input.data[field].slice();
  return Object.freeze({
    owner: input.owner,
    generation: input.generation,
    data: Object.freeze(data),
    rootDeltas: input.rootDeltas.slice(),
    ...(input.bladeVisibility === undefined
      ? {}
      : { bladeVisibility: input.bladeVisibility.slice() }),
  });
}

function words(array: Float32Array): Uint32Array {
  return new Uint32Array(array.buffer, array.byteOffset, array.length);
}

/** Accept a completed BOTH-endpoint sweep, never two separate endpoint passes.
 * Use this same complete region/input/constraint lease as isCurrent in the
 * GrassGroundingContinuation. It must cover arriving/missing neighbors, roads,
 * pads, water, geometry and the installed owner; dependencies alone are not a
 * lease. A failed or missing row keeps its original coarse rendering. */
export function certifyGrassMeadowClearance(
  installed: GrassMeadowInstalledBatch,
  result: GrassBladeGroundingResult,
  isCurrent: () => boolean,
): GrassMeadowClearanceCertificate | null {
  if (!isCurrent() || result.status !== "ready") return null;
  requireValue(
    result.receipt.authoredMeadow?.kind === "meadow-authored-union-v1" &&
      result.receipt.authoredMeadow.authoredVerticesPerBlade === 15 &&
      result.receipt.authoredMeadow.coarseVerticesPerBlade === 7 &&
      result.receipt.bladesPerClump === BLADES &&
      result.receipt.inputClumps === installed.data.count,
    "Meadow clearance requires a combined authored/coarse sweep",
  );
  validateData(installed.data);
  validateData(result.data);
  validateFloats(installed.rootDeltas, installed.data.count * ROOT_WORDS);
  validateFloats(result.rootDeltas, result.data.count * ROOT_WORDS);
  validateMask(installed.bladeVisibility, installed.data.count);
  validateMask(result.bladeVisibility, result.data.count);
  requireValue(
    result.sourceIndices instanceof Uint32Array &&
      result.sourceIndices.buffer instanceof ArrayBuffer &&
      result.sourceIndices.length === result.data.count,
    "Invalid meadow clearance source mapping",
  );
  const bounds = result.sweptBounds;
  requireValue(
    result.data.count === 0
      ? bounds === null
      : bounds !== null &&
          Object.values(bounds).every(Number.isFinite) &&
          bounds.minX <= bounds.maxX &&
          bounds.minY <= bounds.maxY &&
          bounds.minZ <= bounds.maxZ,
    "Invalid meadow clearance union bounds",
  );
  const arrays: { before: Uint32Array; after: Uint32Array; stride: number }[] =
    FIELDS.map(([field, stride]) => ({
      before: words(installed.data[field]),
      after: words(result.data[field]),
      stride,
    }));
  arrays.push({
    before: words(installed.rootDeltas),
    after: words(result.rootDeltas),
    stride: ROOT_WORDS,
  });
  const sourceIndices = new Uint32Array(result.data.count);
  const bladeVisibility = new Uint32Array(result.data.count);
  let previous = -1;
  let accepted = 0;
  for (let row = 0; row < result.data.count; row++) {
    const source = result.sourceIndices[row];
    requireValue(
      source > previous && source < installed.data.count,
      "Invalid meadow clearance source order",
    );
    previous = source;
    const oldMask = installed.bladeVisibility?.[source] ?? ALL_BLADES;
    const newMask = result.bladeVisibility?.[row] ?? ALL_BLADES;
    if ((newMask & oldMask) !== oldMask) continue;
    let identical = true;
    for (const { before, after, stride } of arrays) {
      for (let component = 0; component < stride; component++) {
        if (
          before[source * stride + component] !==
          after[row * stride + component]
        ) {
          identical = false;
          break;
        }
      }
      if (!identical) break;
    }
    if (!identical) continue;
    sourceIndices[accepted] = source;
    bladeVisibility[accepted] = oldMask;
    accepted++;
  }
  if (!isCurrent()) return null;
  return Object.freeze({
    kind: "meadow-authored-clearance-v1",
    owner: installed.owner,
    generation: installed.generation,
    sourceIndices: sourceIndices.slice(0, accepted),
    bladeVisibility: bladeVisibility.slice(0, accepted),
    sweptBounds: bounds === null ? null : Object.freeze({ ...bounds }),
    dependencies: Object.freeze(
      result.dependencies.map((dependency) =>
        Object.freeze({
          surface: dependency.surface,
          uses: Object.freeze([...dependency.uses]),
        }),
      ),
    ),
  });
}
