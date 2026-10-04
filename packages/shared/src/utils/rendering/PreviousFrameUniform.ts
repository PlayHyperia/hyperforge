import { Vector4, type NodeFrame } from "three/webgpu";
import { uniform } from "three/tsl";
import type Renderer from "three/src/renderers/common/Renderer.js";

/**
 * Previous rendered-frame inputs for procedural vertex motion. One snapshot
 * per renderer/frame, not per object or reflection/shadow pass. The node is
 * dormant unless a shader actually consumes it. First use initializes both
 * states equally. Skipped animation callbacks preserve the last rendered
 * snapshot, not an invented time-minus-delta approximation. Frame-clock resets
 * start fresh; camera cuts/history invalidation remain the compositor's job.
 */
export function previousFrameVector4(
  sample: (frame: NodeFrame, target: Vector4) => void,
) {
  const histories = new WeakMap<
    Renderer,
    { frameId: number; current: Vector4; previous: Vector4 }
  >();
  const value = new Vector4();
  return uniform(value).onRenderUpdate((frame) => {
    const { renderer, frameId } = frame;
    if (!renderer) throw new Error("Previous-frame inputs require a renderer");
    let history = histories.get(renderer);
    if (!history) {
      const current = new Vector4();
      sample(frame, current);
      history = { frameId, current, previous: current.clone() };
      histories.set(renderer, history);
    } else if (history.frameId !== frameId) {
      history.previous.copy(history.current);
      sample(frame, history.current);
      if (frameId < history.frameId) history.previous.copy(history.current);
      history.frameId = frameId;
    }
    // Keep the uniform's value object separate from both retained snapshots.
    // Reusing the current value would corrupt history on the next update.
    return value.copy(history.previous);
  });
}
