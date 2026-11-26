import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import THREE from "../../../extras/three/three";
import { previousFrameVector4 } from "../PreviousFrameUniform";

describe("previous procedural-frame inputs (real Three NodeFrame)", () => {
  it("retains one snapshot across objects/passes and isolates renderers", () => {
    const dom = new JSDOM("<canvas></canvas><canvas></canvas>");
    const canvases = dom.window.document.querySelectorAll("canvas");
    const a = new THREE.WebGPURenderer({ canvas: canvases[0] });
    const b = new THREE.WebGPURenderer({ canvas: canvases[1] });
    const first = new THREE.NodeFrame();
    first.renderer = a;
    const second = new THREE.NodeFrame();
    second.renderer = b;
    let samples = 0;
    const anchor = new THREE.Vector2(5, 7);
    const node = previousFrameVector4((frame, value) => {
      samples++;
      value.set(frame.time, anchor.x, anchor.y, 0);
    });
    const update = (frame: THREE.NodeFrame, id: number, time: number) => {
      frame.frameId = id;
      frame.renderId++;
      frame.time = time;
      frame.updateNode(node);
      return node.value.toArray();
    };
    try {
      expect(samples).toBe(0); // No shader consumer, no scheduled CPU work.
      expect(update(first, 10, 1)).toEqual([1, 5, 7, 0]);
      anchor.set(9, 11);
      expect(update(first, 10, 1)).toEqual([1, 5, 7, 0]);
      expect(samples).toBe(1);
      expect(update(first, 11, 2)).toEqual([1, 5, 7, 0]);
      expect(update(first, 11, 2)).toEqual([1, 5, 7, 0]);
      expect(samples).toBe(2);
      expect(update(second, 11, 20)).toEqual([20, 9, 11, 0]);
      // One uniform can be borrowed by another renderer without poisoning A.
      expect(update(first, 11, 2)).toEqual([1, 5, 7, 0]);
      expect(update(first, 12, 3)).toEqual([2, 9, 11, 0]);
      // Public uniform writes must not corrupt the retained snapshot.
      node.value.set(99, 99, 99, 99);
      expect(update(first, 12, 3)).toEqual([2, 9, 11, 0]);
      expect(update(second, 12, 21)).toEqual([20, 9, 11, 0]);
      // Skipped animation callbacks retain the last actually rendered state.
      expect(update(first, 15, 6)).toEqual([3, 9, 11, 0]);
      // A new/reset frame clock starts fresh.
      expect(update(first, 1, 0)).toEqual([0, 9, 11, 0]);
    } finally {
      a.dispose();
      b.dispose();
      dom.window.close();
    }
  });
});
