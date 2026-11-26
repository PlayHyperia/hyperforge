import type { ArrowVisualConfig } from "../../data/spell-visuals";
import * as THREE from "three";

export interface ArrowVisualGeometries {
  shaft: THREE.CylinderGeometry;
  head: THREE.ConeGeometry;
  fletching: THREE.BoxGeometry;
}

export interface ArrowVisualInstance {
  group: THREE.Group;
  geometries: ArrowVisualGeometries;
  shaftMaterial: THREE.MeshBasicMaterial;
  headMaterial: THREE.MeshBasicMaterial;
  fletchingMaterials: [THREE.MeshBasicMaterial, THREE.MeshBasicMaterial];
  ownsGeometries: boolean;
}

function positiveFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Build one reusable geometry set whose local origin is the arrow nock and
 * whose forward axis is +Z. The same shape is used while nocked and in flight,
 * so release cannot visibly swap to a different projectile silhouette.
 */
export function createArrowVisualGeometries(
  config: ArrowVisualConfig,
): ArrowVisualGeometries {
  const length = positiveFinite(config.length, 0.5);
  const width = positiveFinite(config.width, 0.08);
  const shaftLength = length * 0.82;
  const headLength = length * 0.18;
  const shaftRadius = width * 0.15;
  const headRadius = width * 0.4;
  const fletchingLength = length * 0.18;

  const shaft = new THREE.CylinderGeometry(
    shaftRadius,
    shaftRadius,
    shaftLength,
    8,
  );
  shaft.rotateX(Math.PI / 2);
  shaft.translate(0, 0, shaftLength / 2);

  const head = new THREE.ConeGeometry(headRadius, headLength, 8);
  head.rotateX(Math.PI / 2);
  head.translate(0, 0, shaftLength + headLength / 2);

  const fletching = new THREE.BoxGeometry(
    width * 0.65,
    width * 0.08,
    fletchingLength,
  );
  fletching.translate(0, 0, length * 0.03 + fletchingLength / 2);

  return { shaft, head, fletching };
}

function createMaterial(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    toneMapped: false,
  });
}

export function updateArrowVisualColors(
  instance: ArrowVisualInstance,
  config: ArrowVisualConfig,
): void {
  instance.shaftMaterial.color.set(config.shaftColor);
  instance.headMaterial.color.set(config.headColor);
  for (const material of instance.fletchingMaterials) {
    material.color.set(config.fletchingColor);
  }
}

export function createArrowVisualInstance(
  config: ArrowVisualConfig,
  sharedGeometries?: ArrowVisualGeometries,
): ArrowVisualInstance {
  const geometries = sharedGeometries ?? createArrowVisualGeometries(config);
  const group = new THREE.Group();
  group.name = "ArrowVisual";
  group.frustumCulled = false;

  const shaftMaterial = createMaterial(config.shaftColor);
  const headMaterial = createMaterial(config.headColor);
  const fletchingMaterials: [THREE.MeshBasicMaterial, THREE.MeshBasicMaterial] =
    [
      createMaterial(config.fletchingColor),
      createMaterial(config.fletchingColor),
    ];

  const shaft = new THREE.Mesh(geometries.shaft, shaftMaterial);
  shaft.name = "ArrowShaft";
  const head = new THREE.Mesh(geometries.head, headMaterial);
  head.name = "ArrowHead";
  const fletchingA = new THREE.Mesh(
    geometries.fletching,
    fletchingMaterials[0],
  );
  fletchingA.name = "ArrowFletchingHorizontal";
  const fletchingB = new THREE.Mesh(
    geometries.fletching,
    fletchingMaterials[1],
  );
  fletchingB.name = "ArrowFletchingVertical";
  fletchingB.rotation.z = Math.PI / 2;

  for (const mesh of [shaft, head, fletchingA, fletchingB]) {
    mesh.renderOrder = 103;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  return {
    group,
    geometries,
    shaftMaterial,
    headMaterial,
    fletchingMaterials,
    ownsGeometries: !sharedGeometries,
  };
}

export function disposeArrowVisualInstance(
  instance: ArrowVisualInstance,
): void {
  instance.group.removeFromParent();
  instance.shaftMaterial.dispose();
  instance.headMaterial.dispose();
  for (const material of instance.fletchingMaterials) material.dispose();
  if (instance.ownsGeometries) {
    instance.geometries.shaft.dispose();
    instance.geometries.head.dispose();
    instance.geometries.fletching.dispose();
  }
}
