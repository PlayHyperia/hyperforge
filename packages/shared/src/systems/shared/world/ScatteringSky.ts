/**
 * Scattering equations adapted from three.js SkyMesh.
 * Copyright © 2010-2026 three.js authors. The MIT License:
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import THREE from "../../../extras/three/three";
import {
  abs,
  acos,
  clamp,
  cos,
  exp,
  float,
  Fn,
  max,
  mix,
  normalize,
  pow,
  uniform,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";

/** Clear coastal atmosphere candidate, independent of renderer exposure.
 * Analytic scattering follows Three r186 SkyMesh (MIT, three.js authors).
 * https://github.com/mrdoob/three.js/blob/r186/examples/jsm/objects/SkyMesh.js
 * No solar disc, clouds, stars, tone mapping or environment-budget calibration.
 */
export const COASTAL_SCATTERING_SKY = Object.freeze({
  turbidity: 2,
  rayleigh: 2,
  mieCoefficient: 0.005,
  mieDirectionalG: 0.8,
  radianceScale: 0.14,
});

const RAYLEIGH = [
  5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5,
] as const;
const MIE = [
  1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14,
] as const;
const SKY_FLOOR = [0, 0.0003, 0.00075] as const;
export type ScatteringSkyParameters = {
  readonly [K in keyof typeof COASTAL_SCATTERING_SKY]: number;
};

class SolarState {
  x = 0;
  y = 1;
  z = 0;
  energy = 0;
  rayleigh = 0;
}

function setSolarState(
  sun: THREE.Vector3,
  rayleigh: number,
  target: SolarState,
): void {
  const length = sun.length();
  if (!Number.isFinite(length) || length <= 0)
    throw new Error("Scattering sky requires a finite sun direction");
  const x = sun.x / length,
    y = sun.y / length,
    z = sun.z / length;
  target.x = x;
  target.y = y;
  target.z = z;
  target.energy =
    1000 *
    Math.max(
      0,
      1 -
        Math.exp(
          -(1.6110731556870734 - Math.acos(Math.max(-1, Math.min(1, y)))) / 1.5,
        ),
    );
  // SkyMesh uses a normalized sun vector in its example. Retain its sun-fade
  // equation at that scale; the existing game cycle supplies the night blend.
  const sunFade = 1 - Math.max(0, Math.min(1, 1 - Math.exp(y / 450000)));
  target.rayleigh = rayleigh - (1 - sunFade);
}

/** A capture owns its own instance. Only setSun updates shader uniforms;
 * CPU sampling uses separate scratch and cannot change a captured GPU phase. */
export class ScatteringSky {
  readonly parameters: ScatteringSkyParameters;
  private readonly sunDirection = uniform(new THREE.Vector3(0, 1, 0));
  private readonly sunEnergy = uniform(0);
  private readonly betaR = uniform(new THREE.Vector3());
  private readonly betaM = uniform(new THREE.Vector3());
  private readonly gpuSolar = new SolarState();
  private readonly cpuSolar = new SolarState();

  constructor(parameters: ScatteringSkyParameters = COASTAL_SCATTERING_SKY) {
    const {
      turbidity,
      rayleigh,
      mieCoefficient,
      mieDirectionalG,
      radianceScale,
    } = parameters;
    if (
      ![
        turbidity,
        rayleigh,
        mieCoefficient,
        mieDirectionalG,
        radianceScale,
      ].every(Number.isFinite) ||
      turbidity < 1 ||
      turbidity > 20 ||
      rayleigh < 0.1 ||
      rayleigh > 8 ||
      mieCoefficient < 0 ||
      mieCoefficient > 0.1 ||
      mieDirectionalG < 0 ||
      mieDirectionalG > 0.95 ||
      radianceScale <= 0 ||
      radianceScale > 1
    )
      throw new Error("Invalid scattering sky parameters");
    this.parameters = Object.freeze({
      turbidity,
      rayleigh,
      mieCoefficient,
      mieDirectionalG,
      radianceScale,
    });
    const c = 0.2 * turbidity * 10e-18;
    this.betaM.value.set(
      ...(MIE.map((value) => 0.434 * c * value * mieCoefficient) as [
        number,
        number,
        number,
      ]),
    );
    this.setSun(this.sunDirection.value);
  }

  setSun(sun: THREE.Vector3): void {
    setSolarState(sun, this.parameters.rayleigh, this.gpuSolar);
    const state = this.gpuSolar;
    this.sunDirection.value.set(state.x, state.y, state.z);
    this.sunEnergy.value = state.energy;
    this.betaR.value.set(
      RAYLEIGH[0] * state.rayleigh,
      RAYLEIGH[1] * state.rayleigh,
      RAYLEIGH[2] * state.rayleigh,
    );
  }

  colorNode(viewDirection: Node<"vec3">): Node<"vec3"> {
    return Fn(() => {
      const direction = normalize(viewDirection);
      // Preserve the game's mirrored lower-sky convention for planar water.
      // Lighting captures separately cover that hemisphere with ground radiance.
      const zenith = acos(clamp(abs(direction.y), 0, 1));
      const inverse = float(1).div(
        cos(zenith).add(
          float(0.15).mul(
            pow(float(93.885).sub(zenith.mul(180 / Math.PI)), -1.253),
          ),
        ),
      );
      const extinction = exp(
        this.betaR
          .mul(inverse.mul(8400))
          .add(this.betaM.mul(inverse.mul(1250)))
          .negate(),
      ).toVar();
      const cosTheta = clamp(direction.dot(this.sunDirection), -1, 1);
      const phaseR = float(0.05968310365946075).mul(
        float(1).add(pow(cosTheta.mul(0.5).add(0.5), 2)),
      );
      const g = this.parameters.mieDirectionalG,
        g2 = g * g;
      const phaseM = float(0.07957747154594767 * (1 - g2)).div(
        pow(float(1 + g2).sub(cosTheta.mul(2 * g)), 1.5),
      );
      const scattering = this.betaR
        .mul(phaseR)
        .add(this.betaM.mul(phaseM))
        .div(this.betaR.add(this.betaM))
        .mul(this.sunEnergy)
        .toVar();
      const horizon = clamp(pow(float(1).sub(this.sunDirection.y), 5), 0, 1);
      const light = pow(
        max(scattering.mul(float(1).sub(extinction)), 0),
        vec3(1.5),
      ).mul(
        mix(
          vec3(1),
          pow(max(scattering.mul(extinction), 0), vec3(0.5)),
          horizon,
        ),
      );
      return light
        .add(extinction.mul(0.1))
        .mul(0.04)
        .add(vec3(...SKY_FLOOR))
        .mul(this.parameters.radianceScale);
    })();
  }

  /** Unscaled-by-IBL CPU counterpart. No allocation or shader-uniform writes. */
  sampleRadiance(
    view: THREE.Vector3,
    sun: THREE.Vector3,
    target: THREE.Color,
  ): void {
    const length = view.length();
    if (!Number.isFinite(length) || length <= 0)
      throw new Error("Scattering sky requires a finite view direction");
    setSolarState(sun, this.parameters.rayleigh, this.cpuSolar);
    const state = this.cpuSolar;
    const x = view.x / length,
      y = view.y / length,
      z = view.z / length;
    const zenith = Math.acos(Math.max(0, Math.min(1, Math.abs(y))));
    const inverse =
      1 /
      (Math.cos(zenith) +
        0.15 * Math.pow(93.885 - (zenith * 180) / Math.PI, -1.253));
    const cosTheta = Math.max(
      -1,
      Math.min(1, x * state.x + y * state.y + z * state.z),
    );
    const phaseR =
      0.05968310365946075 * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2));
    const g = this.parameters.mieDirectionalG,
      g2 = g * g;
    const phaseM =
      (0.07957747154594767 * (1 - g2)) /
      Math.pow(1 + g2 - 2 * g * cosTheta, 1.5);
    const horizon = Math.max(0, Math.min(1, Math.pow(1 - state.y, 5)));
    for (let channel = 0; channel < 3; channel++) {
      const betaR = RAYLEIGH[channel] * state.rayleigh;
      const betaM = this.betaM.value.getComponent(channel);
      const extinction = Math.exp(
        -(betaR * (inverse * 8400) + betaM * (inverse * 1250)),
      );
      const scattering =
        ((betaR * phaseR + betaM * phaseM) / (betaR + betaM)) * state.energy;
      const light =
        Math.pow(Math.max(scattering * (1 - extinction), 0), 1.5) *
        (1 * (1 - horizon) +
          Math.pow(Math.max(scattering * extinction, 0), 0.5) * horizon);
      const value =
        ((light + extinction * 0.1) * 0.04 + SKY_FLOOR[channel]) *
        this.parameters.radianceScale;
      if (channel === 0) target.r = value;
      else if (channel === 1) target.g = value;
      else target.b = value;
    }
  }
}
