import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserSource = readFileSync(
  new URL("./duel-avatar-motion-browser.ts", import.meta.url),
  "utf8",
);
const captureSource = readFileSync(
  new URL("./capture-duel-avatar-motion.mjs", import.meta.url),
  "utf8",
);

test("the motion audit requires a real WebGPU backend with no WebGL fallback", () => {
  assert.match(browserSource, /new THREE\.WebGPURenderer\(/u);
  assert.match(browserSource, /_getFallback = null/u);
  assert.match(browserSource, /isWebGPUBackend !== true/u);
  assert.match(browserSource, /rendererBackend: "webgpu"/u);
  assert.doesNotMatch(browserSource, /WebGLRenderer/u);
});

test("body previews use production node materials and honor their declared camera angles", () => {
  assert.match(browserSource, /prepareVRMMaterialsForWebGPU\(vrm\.scene\)/u);
  const bodyCamera = browserSource.slice(
    browserSource.indexOf(
      "  } else {\n    const yaw = THREE.MathUtils.degToRad(motion.cameraYawDegrees",
    ),
    browserSource.indexOf(
      "  camera.updateProjectionMatrix();",
      browserSource.indexOf(
        "  } else {\n    const yaw = THREE.MathUtils.degToRad(motion.cameraYawDegrees",
      ),
    ),
  );
  assert.match(bodyCamera, /motion\.cameraYawDegrees/u);
  assert.match(bodyCamera, /motion\.cameraPitchDegrees/u);
  assert.match(bodyCamera, /Math\.sin\(yaw\) \* horizontalDistance/u);
  assert.match(bodyCamera, /Math\.cos\(yaw\) \* horizontalDistance/u);
});

test("the capture process launches Chrome on Metal and verifies the browser report", () => {
  assert.match(captureSource, /headless: false/u);
  assert.doesNotMatch(captureSource, /headless: true/u);
  assert.match(captureSource, /argument\.startsWith\("--headless"\)/u);
  assert.match(captureSource, /HeadlessChrome/u);
  assert.match(captureSource, /report\.browserLaunch =/u);
  assert.match(captureSource, /--enable-unsafe-webgpu/u);
  assert.match(captureSource, /--use-angle=metal/u);
  assert.match(captureSource, /rendererBackend !== "webgpu"/u);
  assert.match(captureSource, /report\.contactSheet =/u);
  assert.match(captureSource, /sha256: sha256\(screenshot\)/u);
  assert.match(captureSource, /report\.browserBundle =/u);
  assert.match(captureSource, /sha256: sha256\(bundle\)/u);
});

test("projected-overlap evidence uses asynchronous GPU readback", () => {
  assert.match(browserSource, /await renderer\.renderAsync\(scene, camera\)/u);
  assert.match(browserSource, /readRenderTargetPixelsAsync/u);
  assert.doesNotMatch(browserSource, /readRenderTargetPixels\(/u);
  assert.match(browserSource, /collectProjectedMaskMeshes\(scene\)/u);
  assert.match(browserSource, /await renderMask\(new Set\(\)\)/u);
  assert.match(browserSource, /if \(leakedPixels !== 0\)/u);
  assert.match(browserSource, /isolationControlPixels: leakedPixels/u);
});

test("the opt-in production overlap proof binds the canonical VRM and emote bytes", () => {
  assert.match(captureSource, /--production-vrm-overlap/u);
  assert.match(
    captureSource,
    /authoredMotion: "emotes\/emote_sword_swing\.glb"/u,
  );
  assert.match(captureSource, /idleMotion: "emotes\/emote-idle\.glb"/u);
  assert.match(captureSource, /sha256: sha256\(readFileSync\(assetPath\)\)/u);
  assert.match(captureSource, /productionVrmOverlap\.screenshotEvidence =/u);
  assert.match(captureSource, /evidenceCardIds:/u);
  assert.match(captureSource, /productionVrmOverlap\.executionSource =/u);
  assert.match(captureSource, /browserBundle:/u);
  assert.match(captureSource, /PRODUCTION_VRM_OVERLAP_SOURCES/u);
});

test("the production overlap proof exercises the actual VRM factory public path", () => {
  assert.match(browserSource, /createVRMFactory\(avatarGlb\)/u);
  assert.match(
    browserSource,
    /factory\.create\(new THREE\.Matrix4\(\), hooks\)/u,
  );
  assert.match(browserSource, /if \(!instance\)/u);
  assert.match(browserSource, /instance\.setEmote\(/u);
  assert.match(browserSource, /instance\.triggerHitReaction\(1, 1\)/u);
  assert.match(browserSource, /instance\.update\(0\.0504\)/u);
  assert.match(browserSource, /instance\.getAuthoredMotionDiagnostics\(\)/u);
  assert.match(browserSource, /instance\.getHitReactionDiagnostics\(\)/u);
  assert.match(browserSource, /await renderer\.renderAsync\(scene, camera\)/u);
});

test("negative controls retain positive hit weight and remove only authored eligibility", () => {
  assert.equal(
    browserSource.match(/instance\.triggerHitReaction\(1, 1\)/gu)?.length,
    4,
  );
  assert.match(
    browserSource,
    /PRODUCTION_VRM_POSITIVE_HIT_CONTROL_TRIGGER_COUNTS/u,
  );
  assert.match(browserSource, /"idle-only": 2/u);
  assert.match(browserSource, /"paused-authored": 3/u);
  assert.match(browserSource, /"no-weight": 4/u);
  assert.match(browserSource, /hasStrictContributingHitReaction/u);
  assert.match(
    browserSource,
    /negative control requires positive hit contribution/u,
  );
  assert.match(browserSource, /"idle-only", false/u);
  assert.match(browserSource, /"paused-authored",\s+false/u);
  assert.match(browserSource, /"no-weight", false/u);
  assert.match(
    browserSource,
    /baseline is not exclusively active authored motion/u,
  );
  assert.match(
    browserSource,
    /idle control is not exclusively active idle motion/u,
  );
  assert.match(
    browserSource,
    /paused control is not a stopped authored action/u,
  );
  assert.match(browserSource, /diagnostics\.actions\.length === 0/u);
  assert.match(browserSource, /action\.paused && !action\.running/u);
  assert.match(browserSource, /hasActiveNonIdleAuthoredMotion/u);
  assert.match(browserSource, /observedOverlap !== expectedOverlap/u);
});

test("every production evidence card waits for a browser frame and rejects blank output", () => {
  assert.match(
    browserSource,
    /await new Promise<void>\(\(resolve\) =>\s+requestAnimationFrame\(\(\) => resolve\(\)\)\)/u,
  );
  assert.match(browserSource, /context\.getImageData\(/u);
  assert.match(browserSource, /PRODUCTION_VRM_OVERLAP_MIN_VISIBLE_PIXELS/u);
  assert.match(
    browserSource,
    /snapshot\.visiblePixelCount = visiblePixelCount/u,
  );
  assert.match(browserSource, /rendered only \$\{visiblePixelCount\}/u);
});
