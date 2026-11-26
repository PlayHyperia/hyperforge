// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import THREE, { texture3D, uniform, vec4 } from "../../../extras/three/three";
import { nodeObject } from "three/tsl";
import { lut3D } from "three/examples/jsm/tsl/display/Lut3DNode.js";
import { LUTCubeLoader } from "three/examples/jsm/loaders/LUTCubeLoader.js";
import {
  createPostProcessing,
  getPostProcessingLUTColor,
  setPostProcessingLUTTexture,
} from "../PostProcessingFactory";

// Real addon/TSL objects and an uninitialized real renderer. These tests do not
// request a GPU device, compile shaders, render pixels, or certify effect quality.
function parseIdentityCube(size: number) {
  const lines = [`LUT_3D_SIZE ${size}`];
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        lines.push(`${x / (size - 1)} ${y / (size - 1)} ${z / (size - 1)}`);
      }
    }
  }
  return new LUTCubeLoader().parse(lines.join("\n")).texture3D;
}

describe("r186 post-processing public API", () => {
  it("builds the actual factory graph without the removed PostProcessing alias", async () => {
    expect(THREE.REVISION).toBe("186");
    const renderer = new THREE.WebGPURenderer({
      canvas: document.createElement("canvas"),
    });
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const composer = await createPostProcessing(renderer, scene, camera, {
      colorGrading: { enabled: false, lut: "bourbon" },
      depthBlur: { enabled: true, intensity: 0.25 },
    });
    try {
      expect(composer.getCurrentLUT()).toBe("none");
      expect(composer.isLUTEnabled()).toBe(false);
      expect(composer.isDepthBlurEnabled()).toBe(true);
      composer.setDepthBlur(false);
      expect(composer.isDepthBlurEnabled()).toBe(false);
      composer.setDepthBlurIntensity(0.6);
      expect(composer.isDepthBlurEnabled()).toBe(true);
      composer.setOutlineObjects([new THREE.Object3D()]);
      composer.setOutlineObjects([]);
      composer.setOutlineColor(new THREE.Color(0xffffff));
      composer.setSize(640, 360);
    } finally {
      composer.dispose();
      composer.dispose();
      // A stale application callback after teardown must not initialize/render.
      composer.render();
      await composer.renderAsync();
      await renderer.dispose();
    }
  });

  it("updates both the real LUT texture node and its public size uniform", () => {
    const identity = parseIdentityCube(2);
    const replacement = parseIdentityCube(3);
    const intensity = uniform(0.75);
    const node = lut3D(
      vec4(0.2, 0.4, 0.6, 0.5),
      texture3D(identity),
      2,
      intensity,
    );
    try {
      const color = getPostProcessingLUTColor(node);
      const builder = new THREE.NodeBuilder(null, null);
      expect(nodeObject(node)).toBe(node);
      expect(color).toBe(node);
      expect(node.getNodeType(builder)).toBe("vec4");
      expect(color.rgb.getNodeType(builder)).toBe("vec3");
      expect(color.a.getNodeType(builder)).toBe("float");
      expect(color.rgb.add(1).getNodeType(builder)).toBe("vec3");
      node.nodeType = "vec3";
      expect(() => getPostProcessingLUTColor(node)).toThrow("produce vec4");
      node.nodeType = "vec4";
      setPostProcessingLUTTexture(node, replacement);
      expect(node.lutNode.value).toBe(replacement);
      expect(node.size.value).toBe(3);
      expect(node.intensityNode).toBe(intensity);
      setPostProcessingLUTTexture(node, identity);
      expect(node.lutNode.value).toBe(identity);
      expect(node.size.value).toBe(2);
    } finally {
      node.dispose();
      identity.dispose();
      replacement.dispose();
    }
  });

  it("uses real loader requests without stale selection or shared composer cache ownership", async () => {
    let releaseBourbon = () => {};
    let notifyBourbon = () => {};
    const bourbonGate = new Promise<void>((resolve) => {
      releaseBourbon = resolve;
    });
    const bourbonStarted = new Promise<void>((resolve) => {
      notifyBourbon = resolve;
    });
    let releaseRemy = () => {};
    let notifyRemy = () => {};
    const remyGate = new Promise<void>((resolve) => {
      releaseRemy = resolve;
    });
    const remyStarted = new Promise<void>((resolve) => {
      notifyRemy = resolve;
    });
    const requests = new Map<string, number>();
    const cube =
      "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";
    const server = createServer(async (request, response) => {
      const path = decodeURIComponent(request.url ?? "");
      requests.set(path, (requests.get(path) ?? 0) + 1);
      if (path.includes("Bourbon")) {
        notifyBourbon();
        await bourbonGate;
      }
      if (path.includes("Remy")) {
        notifyRemy();
        await remyGate;
      }
      response.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(cube),
      });
      response.end(cube);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("HTTP fixture address unavailable");
    THREE.DefaultLoadingManager.setURLModifier(
      (url) => new URL(url, `http://127.0.0.1:${address.port}`).href,
    );
    const renderer = new THREE.WebGPURenderer({
      canvas: document.createElement("canvas"),
    });
    const first = await createPostProcessing(
      renderer,
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
    );
    const second = await createPostProcessing(
      renderer,
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
    );
    const pending: Promise<void>[] = [];
    try {
      pending.push(first.setLUT("bourbon"), first.setLUT("bourbon"));
      await bourbonStarted;
      await first.setLUT("clayton");
      expect(first.getCurrentLUT()).toBe("clayton");
      releaseBourbon();
      await Promise.all(pending);
      expect(first.getCurrentLUT()).toBe("clayton");
      expect(requests.get("/luts/Bourbon 64.CUBE")).toBe(1);
      await first.setLUT("bourbon");
      await second.setLUT("bourbon");
      expect(requests.get("/luts/Bourbon 64.CUBE")).toBe(2);
      first.dispose();
      await second.setLUT("none");
      await second.setLUT("bourbon");
      expect(second.isLUTEnabled()).toBe(true);
      expect(requests.get("/luts/Bourbon 64.CUBE")).toBe(2);
      pending.push(second.setLUT("remy"));
      await remyStarted;
      second.dispose();
      releaseRemy();
      await Promise.all(pending);
      expect(second.getCurrentLUT()).not.toBe("remy");
    } finally {
      releaseBourbon();
      releaseRemy();
      await Promise.allSettled(pending);
      first.dispose();
      second.dispose();
      await renderer.dispose();
      THREE.DefaultLoadingManager.setURLModifier((url) => url);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects malformed LUT dimensions before changing either node binding", () => {
    const identity = parseIdentityCube(2);
    const invalid = new THREE.Data3DTexture(new Uint8Array(24), 2, 3, 1);
    const node = lut3D(vec4(1), texture3D(identity), 2, uniform(1));
    try {
      expect(() => setPostProcessingLUTTexture(node, invalid)).toThrow("cubic");
      expect(node.lutNode.value).toBe(identity);
      expect(node.size.value).toBe(2);
    } finally {
      node.dispose();
      identity.dispose();
      invalid.dispose();
    }
  });
});
