import { Color, Vector3, type Node, type UniformNode } from "three/webgpu";
import {
  add,
  clamp,
  dot,
  float,
  max,
  mix,
  mul,
  normalize,
  select,
  uniform,
} from "three/tsl";

/**
 * Opt-in illumination for custom RGB shaders, not a PBR/environment-map path.
 * Each material owns its nodes; a controller borrows and restores their values.
 * Set linear, finite, nonnegative RGB (no sRGB decoding here): keyColor is direct
 * irradiance at normal incidence, fillColor is isotropic diffuse irradiance.
 * Diffuse outgoing radiance = albedo * (key * max(N.L, 0) + fill) / PI.
 * Set keyDirection FROM the surface TOWARD the actual key before enabling:
 * light world position minus target world position (finite and nonzero). It is
 * separate from legacy sunDirection: Environment adds a positional Y offset.
 * No shadow visibility, directional IBL, Fresnel BRDF or volumetric transport is
 * implied. No textures, renderer ownership, frame callbacks or global state.
 */
export class WorldIlluminationUniforms {
  readonly blend: UniformNode<"float", number> = uniform(0);
  readonly keyColor: UniformNode<"color", Color> = uniform(new Color(1, 1, 1));
  readonly fillColor: UniformNode<"color", Color> = uniform(new Color(0, 0, 0));
  readonly keyDirection: UniformNode<"vec3", Vector3> = uniform(
    new Vector3(0, 1, 0),
  );

  /** Graph construction only. Reuses the caller's normal/direction and samples. */
  diffuse(albedo: Node<"vec3">, normal: Node<"vec3">): Node<"vec3"> {
    const cosine = max(
      dot(normalize(normal), normalize(this.keyDirection)),
      float(0),
    );
    return mul(
      albedo,
      mul(
        add(mul(this.keyColor.rgb, cosine), this.fillColor.rgb),
        float(1 / Math.PI),
      ),
    );
  }

  /** Isotropic radiance corresponding to fill irradiance; water approximation. */
  fillRadiance(): Node<"vec3"> {
    return mul(this.fillColor.rgb, float(1 / Math.PI));
  }

  /** Exact legacy selection at zero; changing values never rebuilds the graph. */
  select(legacy: Node<"vec3">, illuminated: Node<"vec3">): Node<"vec3"> {
    return select(
      this.blend.lessThanEqual(0),
      legacy,
      mix(legacy, illuminated, clamp(this.blend, float(0), float(1))),
    );
  }
}
