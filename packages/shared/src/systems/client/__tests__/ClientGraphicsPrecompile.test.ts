import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { World } from "../../../core/World";
import { ClientGraphics } from "../ClientGraphics";

// Real World and ClientGraphics; no renderer substitute or browser globals.
// GPU compile/visibility behavior still requires the actual WebGPU harness.
describe("ClientGraphics renderer preparation", () => {
  it("executes typed startup operations serially and reports actual pending work", async () => {
    const graphics = new ClientGraphics(new World());
    let finish!: (value: number) => void;
    const barrier = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const events: string[] = [];
    expect(graphics.isPrecompileIdle()).toBe(true);
    const first = graphics.prepareRenderer(() => {
      events.push("first");
      return barrier;
    });
    const second = graphics.prepareRenderer(() => {
      events.push("second");
      return "prepared";
    });
    expect(graphics.isPrecompileIdle()).toBe(false);
    await Promise.resolve();
    expect(events).toEqual(["first"]);
    finish(4);
    expect(await first).toBe(4);
    expect(await second).toBe("prepared");
    expect(events).toEqual(["first", "second"]);
    expect(graphics.isPrecompileIdle()).toBe(true);
  });

  it("propagates callback errors without poisoning later preparation", async () => {
    const graphics = new ClientGraphics(new World());
    const error = new Error("preparation rejected");
    await expect(
      graphics.prepareRenderer(() => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(await graphics.prepareRenderer(async () => 5)).toBe(5);
    expect(graphics.isPrecompileIdle()).toBe(true);
  });

  it("retains the actual compiler restoration order and one shared queue", () => {
    const source = readFileSync(
      new URL("../ClientGraphics.ts", import.meta.url),
      "utf8",
    );
    const compile = source.slice(
      source.indexOf("private async precompileObjectNow("),
      source.indexOf("override commit()"),
    );
    const invoke = compile.indexOf("this.renderer.compileAsync(");
    const restoreVisibility = compile.indexOf(
      "object.visible = previousVisible;",
      invoke,
    );
    const restoreFrustum = compile.indexOf(
      "state.object.frustumCulled = state.value;",
      invoke,
    );
    const arm = compile.indexOf("startCallerDeadline();", invoke);
    const settle = compile.indexOf("await compilation;", invoke);
    const restoreGrass = compile.indexOf("?.finishGrassForRender();", invoke);
    expect(compile).toContain("ClientGraphics.RENDERER_READY_TIMEOUT_MS");
    expect(compile.slice(invoke, restoreVisibility)).toContain("finally");
    expect(invoke).toBeGreaterThan(0);
    expect(restoreVisibility).toBeGreaterThan(invoke);
    expect(restoreFrustum).toBeGreaterThan(restoreVisibility);
    expect(restoreGrass).toBeGreaterThan(restoreFrustum);
    expect(arm).toBeGreaterThan(restoreGrass);
    expect(settle).toBeGreaterThan(arm);
    expect(compile).not.toContain("Promise.race");
    const entrypoints = source.slice(
      source.indexOf("precompileObject(object:"),
      source.indexOf("isPrecompileIdle():"),
    );
    expect(
      entrypoints.match(/this\.rendererPreparationQueue\.run\(/gu),
    ).toHaveLength(2);
    expect(source).toContain("PRECOMPILE_TIMEOUT_MS = 15_000");
    expect(source).toContain(
      "return this.rendererPreparationQueue.pendingCount === 0",
    );
  });

  it("prepares projected trees once at the primary submission boundary", () => {
    // Wiring guard; actual pool tests exercise late-pose selection and native
    // WebGPU remains responsible for final rendered transition acceptance.
    const source = readFileSync(
      new URL("../ClientGraphics.ts", import.meta.url),
      "utf8",
    );
    const render = source.slice(
      source.indexOf("  render() {"),
      source.indexOf("  precompileObject(object:"),
    );
    const call = "prepareGLBTreeBatchedInstancerForRender(this.world.camera);";
    expect(source.split(call)).toHaveLength(2);
    const prepare = render.indexOf(call);
    const submit = render.indexOf("this.renderer.render(");
    expect(prepare).toBeGreaterThan(0);
    expect(submit).toBeGreaterThan(prepare);
    expect(render.indexOf("this.composer.render();")).toBeGreaterThan(prepare);
  });

  it("retains grass range cleanup inside the actual scene submission finally", () => {
    // Wiring guard only: native WebGPU still verifies callback failure and
    // nested reflection restoration. Do not substitute a pretend renderer.
    const source = readFileSync(
      new URL("../ClientGraphics.ts", import.meta.url),
      "utf8",
    );
    const render = source.slice(
      source.indexOf("  render() {"),
      source.indexOf("  precompileObject(object:"),
    );
    const scene = render.indexOf("this.renderer.render(");
    const composer = render.indexOf("this.composer.render();");
    const cleanup = render.indexOf("?.finishGrassForRender();");
    const acknowledge = render.indexOf("this.hasRendered = true;");
    expect(scene).toBeGreaterThan(0);
    expect(composer).toBeGreaterThan(scene);
    expect(cleanup).toBeGreaterThan(composer);
    expect(render.slice(composer, cleanup)).toContain("finally");
    expect(acknowledge).toBeGreaterThan(cleanup);
    // The independent shadow candidate must not prevent range cleanup if its
    // own release throws; the normal committed renderer has no such owner.
    const shadow = render.indexOf("endShadowScope?.();");
    if (shadow !== -1)
      expect(render.slice(shadow, cleanup)).toContain("finally");
  });
});
