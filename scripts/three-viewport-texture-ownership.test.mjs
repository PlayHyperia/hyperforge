import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(require.resolve("three/webgpu")), "..");
const entries = [
  ["public WebGPU bundle", "three/webgpu"],
  ["WebGPU source", "three/src/Three.WebGPU.js"],
  [
    "WebGPU nodes bundle",
    pathToFileURL(resolve(packageRoot, "build/three.webgpu.nodes.js")).href,
  ],
];

// Real Three objects and public node methods only. No renderer or GPU is
// fabricated. This isolates the mutable image metadata that updateBefore uses;
// actual nested rendering and native texture lifetime remain browser gates.
function resizeViewportMetadata(texture, target) {
  const changed =
    texture.image.width !== target.width ||
    texture.image.height !== target.height;
  if (changed) {
    texture.image.width = target.width;
    texture.image.height = target.height;
    texture.needsUpdate = true;
  }
  return changed;
}

function own(t, ...objects) {
  t.after(() => {
    for (const object of new Set(objects)) object.dispose();
  });
}

function settings(texture) {
  return {
    mapping: texture.mapping,
    wrapS: texture.wrapS,
    wrapT: texture.wrapT,
    magFilter: texture.magFilter,
    minFilter: texture.minFilter,
    anisotropy: texture.anisotropy,
    format: texture.format,
    type: texture.type,
    generateMipmaps: texture.generateMipmaps,
    flipY: texture.flipY,
    premultiplyAlpha: texture.premultiplyAlpha,
    unpackAlignment: texture.unpackAlignment,
    colorSpace: texture.colorSpace,
    compareFunction: texture.compareFunction,
    offset: texture.offset.toArray(),
    repeat: texture.repeat.toArray(),
    center: texture.center.toArray(),
    rotation: texture.rotation,
    matrix: texture.matrix.toArray(),
    matrixAutoUpdate: texture.matrixAutoUpdate,
  };
}

for (const [entry, specifier] of entries) {
  const THREE = await import(specifier);
  assert.equal(THREE.REVISION, "186", `${entry}: exact renderer revision`);

  test(`${entry}: each viewport reference owns its source and image, while sample aliases reuse its cache`, (t) => {
    const node = new THREE.ViewportTextureNode();
    const outer = new THREE.RenderTarget(1280, 720);
    const inner = new THREE.RenderTarget(640, 360);
    const a = node.getTextureForReference(outer);
    const b = node.getTextureForReference(inner);
    own(t, outer, inner, a, b, node.defaultFramebuffer);

    assert(a instanceof THREE.FramebufferTexture);
    assert(b instanceof THREE.FramebufferTexture);
    assert.notEqual(a, b);
    assert.notEqual(a.uuid, b.uuid);
    assert(a.source instanceof THREE.TextureSource);
    assert(b.source instanceof THREE.TextureSource);
    assert.notEqual(
      a.source,
      b.source,
      "separate targets must not share Source",
    );
    assert.notEqual(
      a.image,
      b.image,
      "separate targets must not share dimensions",
    );
    assert.notEqual(a.source, node.defaultFramebuffer.source);
    assert.notEqual(b.source, node.defaultFramebuffer.source);
    assert.equal(node.getTextureForReference(outer), a);
    assert.equal(node.getTextureForReference(inner), b);
    assert.equal(node.getTextureForReference(null), node.defaultFramebuffer);

    const sample = node.sample(
      new THREE.ConstNode(new THREE.Vector2(0.2, 0.8)),
    );
    assert.equal(sample.getTextureForReference(outer), a);
    assert.equal(sample.getTextureForReference(inner), b);
  });

  test(`${entry}: alternating main/reflection dimensions stabilize after each target's first upload`, (t) => {
    const node = new THREE.ViewportTextureNode();
    const outer = new THREE.RenderTarget(1280, 720);
    const inner = new THREE.RenderTarget(640, 360);
    const a = node.getTextureForReference(outer);
    const b = node.getTextureForReference(inner);
    own(t, outer, inner, a, b, node.defaultFramebuffer);
    const defaultImage = { ...node.defaultFramebuffer.image };
    const defaultVersion = node.defaultFramebuffer.version;
    const initial = [a.version, b.version];
    const changes = [];
    for (let frame = 0; frame < 6; frame++) {
      changes.push(resizeViewportMetadata(a, outer));
      changes.push(resizeViewportMetadata(b, inner));
    }
    assert.deepEqual(changes, [true, true, ...Array(10).fill(false)]);
    assert.deepEqual(
      [a.version, b.version],
      initial.map((value) => value + 1),
    );
    assert.deepEqual([a.image.width, a.image.height], [1280, 720]);
    assert.deepEqual([b.image.width, b.image.height], [640, 360]);
    assert.deepEqual(node.defaultFramebuffer.image, defaultImage);
    assert.equal(node.defaultFramebuffer.version, defaultVersion);

    // A legitimate resize invalidates only its own copy, once.
    outer.setSize(960, 540);
    const beforeResize = [a.version, b.version];
    assert.equal(resizeViewportMetadata(a, outer), true);
    assert.equal(resizeViewportMetadata(b, inner), false);
    assert.equal(resizeViewportMetadata(a, outer), false);
    assert.deepEqual(
      [a.version, b.version],
      [beforeResize[0] + 1, beforeResize[1]],
    );
    assert.deepEqual([b.image.width, b.image.height], [640, 360]);
  });

  test(`${entry}: custom framebuffer settings survive copying without aliasing the supplied dimensions`, (t) => {
    const supplied = new THREE.FramebufferTexture(320, 180);
    supplied.type = THREE.HalfFloatType;
    supplied.minFilter = THREE.LinearMipmapLinearFilter;
    supplied.magFilter = THREE.LinearFilter;
    supplied.wrapS = THREE.RepeatWrapping;
    supplied.wrapT = THREE.MirroredRepeatWrapping;
    supplied.generateMipmaps = true;
    supplied.flipY = false;
    supplied.premultiplyAlpha = true;
    supplied.colorSpace = THREE.LinearSRGBColorSpace;
    supplied.unpackAlignment = 1;
    supplied.anisotropy = 4;
    supplied.offset.set(0.1, 0.2);
    supplied.repeat.set(2, 3);
    supplied.rotation = 0.25;
    supplied.updateMatrix();
    const originalSource = supplied.source;
    const originalImage = supplied.image;
    const expectedSettings = settings(supplied);
    const node = new THREE.ViewportTextureNode(undefined, null, supplied);
    const target = new THREE.RenderTarget(1280, 720);
    const copy = node.getTextureForReference(target);
    own(t, target, supplied, copy);

    assert(copy instanceof THREE.FramebufferTexture);
    assert.equal(node.defaultFramebuffer, supplied);
    assert.equal(node.getTextureForReference(null), supplied);
    assert.deepEqual(settings(copy), expectedSettings);
    assert.deepEqual(copy.image, originalImage);
    assert.notEqual(copy.source, originalSource);
    assert.notEqual(copy.image, originalImage);
    assert.equal(resizeViewportMetadata(copy, target), true);
    assert.equal(supplied.source, originalSource);
    assert.equal(supplied.image, originalImage);
    assert.deepEqual(supplied.image, { width: 320, height: 180 });
    assert.deepEqual(settings(copy), expectedSettings);
  });

  test(`${entry}: depth viewport copies retain depth configuration and independent target sizes`, (t) => {
    const supplied = new THREE.DepthTexture(320, 180, THREE.FloatType);
    supplied.compareFunction = THREE.LessEqualCompare;
    supplied.minFilter = THREE.LinearFilter;
    supplied.magFilter = THREE.LinearFilter;
    const originalSource = supplied.source;
    const originalImage = supplied.image;
    const expectedImage = { ...originalImage };
    const expectedSettings = settings(supplied);
    const node = new THREE.ViewportDepthTextureNode(undefined, null, supplied);
    const outer = new THREE.RenderTarget(1280, 720);
    const inner = new THREE.RenderTarget(640, 360);
    const a = node.getTextureForReference(outer);
    const b = node.getTextureForReference(inner);
    own(t, outer, inner, supplied, a, b);

    for (const texture of [a, b]) {
      assert(texture instanceof THREE.DepthTexture);
      assert.equal(texture.isFramebufferTexture, undefined);
      assert.deepEqual(settings(texture), expectedSettings);
      assert.notEqual(texture.source, originalSource);
      assert.notEqual(texture.image, originalImage);
    }
    assert.notEqual(a.source, b.source);
    assert.notEqual(a.image, b.image);
    const changes = [];
    for (let frame = 0; frame < 3; frame++) {
      changes.push(resizeViewportMetadata(a, outer));
      changes.push(resizeViewportMetadata(b, inner));
    }
    assert.deepEqual(changes, [true, true, false, false, false, false]);
    assert.equal(supplied.source, originalSource);
    assert.equal(supplied.image, originalImage);
    assert.deepEqual(supplied.image, expectedImage);
    assert.deepEqual(settings(a), expectedSettings);
    assert.deepEqual(settings(b), expectedSettings);
  });

  test(`${entry}: ordinary Texture.clone still shares asset source and pixel data`, (t) => {
    const pixels = new Uint8Array([25, 50, 75, 255]);
    const image = { width: 1, height: 1, data: pixels };
    const original = new THREE.Texture(image);
    const copy = original.clone();
    own(t, original, copy);
    assert.notEqual(copy.uuid, original.uuid);
    assert.equal(copy.source, original.source);
    assert.equal(copy.image, image);
    assert.equal(copy.image.data, pixels);
    assert.deepEqual(settings(copy), settings(original));
  });
}
