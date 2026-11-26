import { describe, expect, it, vi } from "vitest";

import { TerrainQuadTree, type QuadTreeListener } from "../TerrainQuadTree";

function createUnsplitTree(rootChunkRadius?: number): TerrainQuadTree {
  return new TerrainQuadTree({
    minSize: 100,
    maxDepth: 0,
    splitRatio: 0,
    rootChunkRadius,
  });
}

describe("TerrainQuadTree root retention", () => {
  it("retains the exploration viewport's surrounding 3x3 root grid by default", () => {
    const tree = createUnsplitTree();

    tree.update(0, 0);

    expect(tree.totalNodeCount).toBe(9);
  });

  it("supports a single-root broadcast terrain surface", () => {
    const tree = createUnsplitTree(0);

    tree.update(385, 374);

    expect(tree.totalNodeCount).toBe(1);
    expect(tree.getFinalNodes()).toHaveLength(1);
    expect(tree.getFinalNodes()[0].boundingBox).toEqual({
      xMin: 350,
      xMax: 450,
      zMin: 350,
      zMax: 450,
    });
  });

  it("replaces rather than accumulates a single root when its focus crosses a root boundary", () => {
    const tree = createUnsplitTree(0);
    const listener = {
      onNodeNeedsGeometry: vi.fn(),
      onNodeDestroyGeometry: vi.fn(),
    } satisfies QuadTreeListener;
    tree.setListener(listener);

    tree.update(0, 0);
    const firstNodeId = tree.getFinalNodes()[0].id;
    tree.update(101, 0);

    expect(tree.totalNodeCount).toBe(1);
    expect(tree.getFinalNodes()).toHaveLength(1);
    expect(tree.getFinalNodes()[0].id).not.toBe(firstNodeId);
    expect(listener.onNodeDestroyGeometry).toHaveBeenCalledOnce();
  });

  it("normalizes invalid fractional and negative radii to safe integers", () => {
    const fractional = createUnsplitTree(1.9);
    fractional.update(0, 0);
    expect(fractional.config.rootChunkRadius).toBe(1);
    expect(fractional.totalNodeCount).toBe(9);

    const negative = createUnsplitTree(-10);
    negative.update(0, 0);
    expect(negative.config.rootChunkRadius).toBe(0);
    expect(negative.totalNodeCount).toBe(1);
  });
});
