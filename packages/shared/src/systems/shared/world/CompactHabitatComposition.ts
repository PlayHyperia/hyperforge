/** Bounded authored ground composition. No world coordinates, placement RNG,
 * terrain heights, textures, or population policy live in this module. */

export type CompactHabitatBounds = Readonly<{
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}>;

export type CompactHabitatDescriptor = Readonly<{
  schemaVersion: 1;
  pockets: readonly Readonly<{
    id: string;
    vertices: readonly (readonly [number, number])[];
    edgeWidth: number;
    strength: number;
  }>[];
}>;

type HabitatEdge = Readonly<{
  nx: number;
  nz: number;
  constant: number;
}>;

export type CompactHabitatField = Readonly<{
  descriptor: CompactHabitatDescriptor;
  bounds: CompactHabitatBounds;
  pockets: readonly Readonly<{
    id: string;
    edgeWidth: number;
    strength: number;
    /** Unit inward halfplanes: nx*x + nz*z + constant >= 0 inside. */
    edges: readonly HabitatEdge[];
  }>[];
}>;

/** The same expression can construct real TSL nodes or evaluate CPU numbers.
 * Adapters must preserve scalar operation semantics; no sampling is implicit. */
export type CompactHabitatArithmetic<T> = Readonly<{
  constant(value: number): T;
  add(a: T, b: T): T;
  mul(a: T, b: T): T;
  min(a: T, b: T): T;
  max(a: T, b: T): T;
  smoothstep(low: T, high: T, value: T): T;
}>;

const admittedFields = new WeakSet<CompactHabitatField>();

function invalid(field: string): never {
  throw new Error(`Invalid compact habitat ${field}`);
}

function record(
  input: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    invalid(label);
  const fields = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).length !== keys.length ||
    keys.some((key) => !fields[key] || !("value" in fields[key]))
  )
    invalid(`${label} fields`);
  return input as Record<string, unknown>;
}

function array(input: unknown, min: number, max: number, label: string) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    invalid(label);
  const fields = Object.getOwnPropertyDescriptors(input);
  const length: unknown = Object.getOwnPropertyDescriptor(
    input,
    "length",
  )?.value;
  if (
    typeof length !== "number" ||
    length < min ||
    length > max ||
    Reflect.ownKeys(input).length !== length + 1
  )
    invalid(`${label} length`);
  for (let index = 0; index < length; index++) {
    if (!fields[index] || !("value" in fields[index]))
      invalid(`${label} element`);
  }
  return input as unknown[];
}

function finite(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isFinite(input)) invalid(label);
  return input;
}

type Point = readonly [number, number];

function turn(a: Point, b: Point, c: Point) {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (!Number.isFinite(value)) invalid("polygon numeric range");
  return value;
}

function onSegment(a: Point, b: Point, p: Point) {
  return (
    p[0] >= Math.min(a[0], b[0]) &&
    p[0] <= Math.max(a[0], b[0]) &&
    p[1] >= Math.min(a[1], b[1]) &&
    p[1] <= Math.max(a[1], b[1])
  );
}

function intersect(a: Point, b: Point, c: Point, d: Point) {
  const abC = turn(a, b, c),
    abD = turn(a, b, d);
  const cdA = turn(c, d, a),
    cdB = turn(c, d, b);
  return (
    (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
      ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) ||
    (abC === 0 && onSegment(a, b, c)) ||
    (abD === 0 && onSegment(a, b, d)) ||
    (cdA === 0 && onSegment(c, d, a)) ||
    (cdB === 0 && onSegment(c, d, b))
  );
}

/** Startup/authoring boundary. A field is detached and deeply frozen before
 * either consumer can use it. Bounds are supplied by the admitted world owner,
 * not inferred from a camera, resource ID spelling, or hardcoded location. */
export function validateCompactHabitatComposition(
  input: unknown,
  boundsInput: CompactHabitatBounds,
): CompactHabitatField {
  const rawBounds = record(
    boundsInput,
    ["minX", "maxX", "minZ", "maxZ"],
    "bounds",
  );
  const bounds = Object.freeze({
    minX: finite(rawBounds.minX, "minX"),
    maxX: finite(rawBounds.maxX, "maxX"),
    minZ: finite(rawBounds.minZ, "minZ"),
    maxZ: finite(rawBounds.maxZ, "maxZ"),
  });
  if (
    !(bounds.maxX > bounds.minX) ||
    !(bounds.maxZ > bounds.minZ) ||
    !Number.isFinite(bounds.maxX - bounds.minX) ||
    !Number.isFinite(bounds.maxZ - bounds.minZ)
  )
    invalid("bounds extent");
  const raw = record(input, ["schemaVersion", "pockets"], "descriptor");
  if (raw.schemaVersion !== 1) invalid("schema version");
  const ids = new Set<string>();
  const pockets = array(raw.pockets, 1, 2, "pockets").map((entry) => {
    const pocket = record(
      entry,
      ["id", "vertices", "edgeWidth", "strength"],
      "pocket",
    );
    const id = pocket.id;
    if (
      typeof id !== "string" ||
      !/^[a-z][a-z0-9-]{0,47}$/.test(id) ||
      ids.has(id)
    )
      invalid("pocket ID");
    ids.add(id);
    const edgeWidth = finite(pocket.edgeWidth, "edge width");
    const strength = finite(pocket.strength, "strength");
    if (edgeWidth < 2 || edgeWidth > 4 || strength < 0 || strength > 1)
      invalid("pocket controls");
    const vertices = array(pocket.vertices, 3, 6, "vertices").map(
      (value): Point => {
        const point = array(value, 2, 2, "point");
        const x = finite(point[0], "vertex x"),
          z = finite(point[1], "vertex z");
        if (
          x < bounds.minX ||
          x > bounds.maxX ||
          z < bounds.minZ ||
          z > bounds.maxZ
        )
          invalid("vertex outside admitted bounds");
        return Object.freeze([x, z] as const);
      },
    );
    const count = vertices.length;
    for (let i = 0; i < count; i++) {
      const a = vertices[i],
        b = vertices[(i + 1) % count];
      for (let j = i + 1; j < count; j++) {
        if (a[0] === vertices[j][0] && a[1] === vertices[j][1])
          invalid("duplicate vertex");
        if (
          j !== i + 1 &&
          !(i === 0 && j === count - 1) &&
          intersect(a, b, vertices[j], vertices[(j + 1) % count])
        )
          invalid("self-intersecting polygon");
      }
      if (turn(a, b, vertices[(i + 2) % count]) <= 0)
        invalid("strictly convex counterclockwise polygon required");
    }
    return Object.freeze({
      id,
      vertices: Object.freeze(vertices),
      edgeWidth,
      strength,
    });
  });
  const descriptor: CompactHabitatDescriptor = Object.freeze({
    schemaVersion: 1,
    pockets: Object.freeze(pockets),
  });
  const compiled = pockets.map((pocket) =>
    Object.freeze({
      id: pocket.id,
      edgeWidth: pocket.edgeWidth,
      strength: pocket.strength,
      edges: Object.freeze(
        pocket.vertices.map((a, index) => {
          const b = pocket.vertices[(index + 1) % pocket.vertices.length];
          const dx = b[0] - a[0],
            dz = b[1] - a[1];
          const length = Math.hypot(dx, dz);
          const nx = -dz / length,
            nz = dx / length;
          const constant = -(nx * a[0] + nz * a[1]);
          if (![length, nx, nz, constant].every(Number.isFinite) || length <= 0)
            invalid("edge numeric range");
          return Object.freeze({ nx, nz, constant });
        }),
      ),
    }),
  );
  const field = Object.freeze({
    descriptor,
    bounds,
    pockets: Object.freeze(compiled),
  });
  admittedFields.add(field);
  return field;
}

/** At most twelve signed halfplanes and two smooth transitions. MAX prevents
 * overlapping pockets from accumulating strength. A polygon edge has weight
 * zero; inward distance edgeWidth reaches its authored strength. No global
 * noise, texture, coordinate-dependent allocation, or population rejection. */
export function evaluateCompactHabitatSoil<T>(
  x: T,
  z: T,
  field: CompactHabitatField | null | undefined,
  arithmetic: CompactHabitatArithmetic<T>,
): T {
  let result = arithmetic.constant(0);
  if (field == null) return result;
  if (!admittedFields.has(field)) invalid("unadmitted field");
  for (let pocketIndex = 0; pocketIndex < field.pockets.length; pocketIndex++) {
    const pocket = field.pockets[pocketIndex];
    let distance = evaluateEdgeDistance(x, z, pocket.edges[0], arithmetic);
    for (let index = 1; index < pocket.edges.length; index++)
      distance = arithmetic.min(
        distance,
        evaluateEdgeDistance(x, z, pocket.edges[index], arithmetic),
      );
    result = arithmetic.max(
      result,
      arithmetic.mul(
        arithmetic.constant(pocket.strength),
        arithmetic.smoothstep(
          arithmetic.constant(0),
          arithmetic.constant(pocket.edgeWidth),
          distance,
        ),
      ),
    );
  }
  return result;
}

function evaluateEdgeDistance<T>(
  x: T,
  z: T,
  edge: HabitatEdge,
  arithmetic: CompactHabitatArithmetic<T>,
): T {
  return arithmetic.add(
    arithmetic.add(
      arithmetic.mul(x, arithmetic.constant(edge.nx)),
      arithmetic.mul(z, arithmetic.constant(edge.nz)),
    ),
    arithmetic.constant(edge.constant),
  );
}

const numberArithmetic: CompactHabitatArithmetic<number> = Object.freeze({
  constant: (value: number) => value,
  add: (a: number, b: number) => a + b,
  mul: (a: number, b: number) => a * b,
  min: Math.min,
  max: Math.max,
  smoothstep: (low: number, high: number, value: number) => {
    const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
    return t * t * (3 - 2 * t);
  },
});

export function sampleCompactHabitatSoil(
  x: number,
  z: number,
  field: CompactHabitatField | null | undefined,
): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) invalid("sample coordinate");
  return evaluateCompactHabitatSoil(x, z, field, numberArithmetic);
}
