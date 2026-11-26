import THREE from "../../extras/three/three";

export type ProjectedGeometryMeasurement = Readonly<{
  /** Conservative Euclidean displacement in physical render pixels. */
  errorPixels: number;
  /** Larger dimension of the unclipped, projected local box. */
  extentPixels: number;
}>;

function finiteMatrix(matrix: THREE.Matrix4): boolean {
  for (let i = 0; i < 16; i++)
    if (!Number.isFinite(matrix.elements[i])) return false;
  return true;
}

/**
 * Allocation-free after construction. The returned record is reused: copy its
 * scalar values before another measurement if they need to outlive this call.
 *
 * localSurfaceError must bound a surface displacement in the same local units
 * as localBounds. This projects that supplied bound; it does not certify an
 * offline simplifier's error, shading, silhouettes in motion, or other cameras.
 */
export class ProjectedGeometryError {
  private readonly viewModel = new THREE.Matrix4();
  private readonly clipModel = new THREE.Matrix4();
  private readonly result = { errorPixels: Infinity, extentPixels: Infinity };

  measure(
    camera: THREE.Camera,
    modelMatrix: THREE.Matrix4,
    localBounds: THREE.Box3,
    localSurfaceError: number,
    width: number,
    height: number,
  ): ProjectedGeometryMeasurement {
    this.result.errorPixels = Infinity;
    this.result.extentPixels = Infinity;
    if (
      !(
        camera instanceof THREE.PerspectiveCamera ||
        camera instanceof THREE.OrthographicCamera
      ) ||
      !Number.isFinite(camera.near) ||
      camera.near < 0 ||
      !Number.isFinite(width) ||
      width <= 0 ||
      !Number.isFinite(height) ||
      height <= 0 ||
      !Number.isFinite(localSurfaceError) ||
      localSurfaceError < 0 ||
      !finiteMatrix(modelMatrix) ||
      !finiteMatrix(camera.matrixWorldInverse) ||
      !finiteMatrix(camera.projectionMatrix)
    )
      return this.result;

    const min = localBounds.min,
      max = localBounds.max;
    if (
      !Number.isFinite(min.x) ||
      !Number.isFinite(min.y) ||
      !Number.isFinite(min.z) ||
      !Number.isFinite(max.x) ||
      !Number.isFinite(max.y) ||
      !Number.isFinite(max.z) ||
      min.x > max.x ||
      min.y > max.y ||
      min.z > max.z
    )
      return this.result;

    this.viewModel.multiplyMatrices(camera.matrixWorldInverse, modelMatrix);
    const v = this.viewModel.elements;
    // Affine homogeneous coordinates may have any positive constant W. Three's
    // generic matrix inverse can produce e.g. 1 + Number.EPSILON even for a
    // rigid shadow camera. Preserve that actual W rather than rounding it or
    // rejecting valid cameras; a position-dependent W remains unsupported.
    const viewW = v[15];
    if (
      v[3] !== 0 ||
      v[7] !== 0 ||
      v[11] !== 0 ||
      !(viewW > 0) ||
      !Number.isFinite(viewW)
    )
      return this.result;
    this.clipModel.multiplyMatrices(camera.projectionMatrix, this.viewModel);
    const p = this.clipModel.elements;
    if (!finiteMatrix(this.viewModel) || !finiteMatrix(this.clipModel))
      return this.result;

    let minW = Infinity,
      maxViewZ = -Infinity,
      maxAbsX = 0,
      maxAbsY = 0,
      minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? max.x : min.x,
        y = corner & 2 ? max.y : min.y,
        z = corner & 4 ? max.z : min.z;
      const viewZ = v[2] * x + v[6] * y + v[10] * z + v[14],
        nx = p[0] * x + p[4] * y + p[8] * z + p[12],
        ny = p[1] * x + p[5] * y + p[9] * z + p[13],
        w = p[3] * x + p[7] * y + p[11] * z + p[15];
      if (
        !Number.isFinite(viewZ) ||
        !Number.isFinite(nx) ||
        !Number.isFinite(ny) ||
        !(w > 0) ||
        !Number.isFinite(w)
      )
        return this.result;
      maxViewZ = Math.max(maxViewZ, viewZ);
      minW = Math.min(minW, w);
      maxAbsX = Math.max(maxAbsX, Math.abs(nx));
      maxAbsY = Math.max(maxAbsY, Math.abs(ny));
      minX = Math.min(minX, nx / w);
      maxX = Math.max(maxX, nx / w);
      minY = Math.min(minY, ny / w);
      maxY = Math.max(maxY, ny / w);
    }

    const epsViewZ = localSurfaceError * Math.hypot(v[2], v[6], v[10]);
    // Include the supplied error shell, so neither the base box nor a displaced
    // surface may intersect the near plane (or lie behind an orthographic view).
    // Physical camera Z is viewZ / viewW, including its error shell. Multiplying
    // by positive constant viewW is exact algebra, not an affine tolerance.
    if (maxViewZ + epsViewZ >= -camera.near * viewW) return this.result;

    const epsW = localSurfaceError * Math.hypot(p[3], p[7], p[11]),
      denominator = minW - epsW;
    if (!(denominator > 0)) return this.result;
    const epsX = localSurfaceError * Math.hypot(p[0], p[4], p[8]),
      epsY = localSurfaceError * Math.hypot(p[1], p[5], p[9]);
    // For N/W and displacement (dN,dW),
    // |d(N/W)| <= (epsN + max|N|/minW * epsW) / (minW-epsW).
    // Numerators and W are affine over the box, so their extrema occur at its
    // corners. Positive W also makes the projected box extrema corner extrema.
    const dx = ((epsX + (maxAbsX / minW) * epsW) / denominator) * width * 0.5,
      dy = ((epsY + (maxAbsY / minW) * epsW) / denominator) * height * 0.5,
      errorPixels = Math.hypot(dx, dy),
      extentPixels = Math.max(
        (maxX - minX) * width * 0.5,
        (maxY - minY) * height * 0.5,
      );
    if (!Number.isFinite(errorPixels) || !Number.isFinite(extentPixels))
      return this.result;
    this.result.errorPixels = errorPixels;
    this.result.extentPixels = extentPixels;
    return this.result;
  }
}
