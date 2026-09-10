import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import {
  buildKnightShortswordGripCandidate,
  generateKnightShortswordGripEvidence,
  measureKaykitShortswordGrip,
  type KnightShortswordGripDefinition,
} from "./measure-kaykit-shortsword-grip";
import { validateDuelAvatarMotionDefinition } from "./lib/duel-avatar-motion-manifest.mjs";
import { validateDuelMotionEquipmentSetManifest } from "./lib/duel-motion-equipment-set.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const definition = JSON.parse(
  readFileSync(
    path.join(
      workspaceRoot,
      "scripts/kaykit-shortsword-semantic-grip-definition.json",
    ),
    "utf8",
  ),
) as KnightShortswordGripDefinition;
type Measurement = Awaited<ReturnType<typeof measureKaykitShortswordGrip>>;
let preserved: Measurement;
let translated: Measurement;
let socket: Measurement;
let seated: Measurement;
beforeAll(async () => {
  preserved = await measureKaykitShortswordGrip({ workspaceRoot, definition });
  translated = await measureKaykitShortswordGrip({
    workspaceRoot,
    definition,
    alignHandleToAuthoredSocket: true,
  });
  socket = await measureKaykitShortswordGrip({
    workspaceRoot,
    definition,
    useAuthoredSocketOrientation: true,
  });
  seated = await measureKaykitShortswordGrip({
    workspaceRoot,
    definition,
    useAuthoredSocketOrientation: true,
    seatHandleAgainstSurface: true,
  });
});

describe("actual Knight shortsword semantic contact, never visual approval", () => {
  test("derives handle-only boundaries from complete source topology, not wrist or blade", () => {
    expect(preserved.sourceRegions.handle.triangleCount).toBe(80);
    expect(preserved.sourceRegions.pommel.triangleCount).toBe(112);
    expect(preserved.sourceRegions.guard.triangleCount).toBe(68);
    expect(preserved.sourceRegions.blade.triangleCount).toBe(40);
    expect(preserved.handleTriangleCount).toBe(80);
    expect(preserved.avatarGeometry.mappedWristTriangleCount).toBe(0);
    expect(preserved.avatarGeometry.descendantHandTriangleCount).toBe(136);
    expect(preserved.avatarGeometry.sourceSkinnedMeshCount).toBe(9);
    expect(preserved.gripContact.zones[0].minimumSourceProjection).toBeCloseTo(
      -0.1241551668693622,
      12,
    );
    expect(preserved.gripContact.zones[0].maximumSourceProjection).toBeCloseTo(
      0.11461422344048819,
      12,
    );
  });

  test("retains installed fit's false-positive whole-item contact as a semantic handle failure", () => {
    expect(preserved.wholeSwordContact.intersects).toBe(true);
    expect(preserved.excludedRegionContacts.guard.intersects).toBe(true);
    expect(preserved.handContact.intersects).toBe(false);
    expect(preserved.handContact.minimumSurfaceDistanceMetres).toBeCloseTo(
      0.01935340134500354,
      8,
    );
    expect(preserved.status).toBe("bind-pose-handle-contact-failed");
    expect(preserved.placement.appliedTranslation).toBe(false);
    expect(preserved.placement.measuredAttachmentMatrix).toEqual(
      preserved.placement.preservedAttachmentMatrix,
    );
  });

  test("rejects translation alone as a viable fit: blade penetrates the hand", () => {
    expect(translated.handContact.intersects).toBe(true);
    expect(translated.excludedRegionContacts.blade.intersects).toBe(true);
    expect(translated.placement.actionDirectionDeviationDegrees).toBeLessThan(
      0.00001,
    );
  });

  test("authored socket orientation retains its real gap until an explicit measured surface displacement", () => {
    expect(socket.handContact.intersects).toBe(false);
    expect(socket.handContact.minimumSurfaceDistanceMetres).toBeCloseTo(
      0.0024313255018447995,
      8,
    );
    expect(socket.excludedRegionContacts.blade.intersects).toBe(false);
    expect(seated.placement.unseatedHandContact).toEqual(socket.handContact);
    expect(seated.handContact.intersects).toBe(true);
    expect(seated.excludedRegionContacts.blade.intersects).toBe(false);
    expect(
      seated.excludedRegionContacts.blade.minimumSurfaceDistanceMetres,
    ).toBeGreaterThan(0.027);
    expect(seated.placement.candidateActionDirectionWorld[2]).toBeGreaterThan(
      0.99999,
    );
    expect(seated.placement.actionDirectionDeviationDegrees).toBeCloseTo(
      38.38888309957801,
      6,
    );
    expect(seated.placement.seating?.numericalInsetMetres).toBeLessThan(
      0.000001,
    );
    expect(
      seated.placement.handleCenterToAuthoredSocketDistanceMetres,
    ).toBeLessThan(0.0025);
    expect(seated.gripContact).toEqual(preserved.gripContact);
    expect(seated.unchangedContentScale).toEqual(
      preserved.unchangedContentScale,
    );
    // These remain explicit unresolved visual contacts, not a green-only projection.
    expect(seated.excludedRegionContacts.guard.intersects).toBe(true);
    expect(seated.excludedRegionContacts.pommel.intersects).toBe(true);
    expect(seated.status).toBe(
      "bind-pose-handle-contact-observed-not-visual-approval",
    );
  });

  test("produces reproducible metadata-only control and wrapper-only isolated candidate bytes", () => {
    const source = readFileSync(
      path.join(workspaceRoot, definition.equipment.path),
    );
    for (const measurement of [preserved, seated]) {
      const result = buildKnightShortswordGripCandidate({
        workspaceRoot,
        definition,
        measurement,
      });
      const repeated = buildKnightShortswordGripCandidate({
        workspaceRoot,
        definition,
        measurement,
      });
      expect(result.output.equals(repeated.output)).toBe(true);
      expect(result.report.productApproved).toBe(false);
      expect(result.report.preservedAllTransforms).toBe(
        measurement === preserved,
      );
      expect(result.report.preservedNonWrapperTransforms).toBe(true);
      expect(
        result.output
          .subarray(20 + result.output.readUInt32LE(12))
          .equals(source.subarray(20 + source.readUInt32LE(12))),
      ).toBe(true);
      expect(createHash("sha256").update(result.output).digest("hex")).toBe(
        result.report.candidateSha256,
      );
      const json = JSON.parse(
        result.output
          .subarray(20, 20 + result.output.readUInt32LE(12))
          .toString("utf8"),
      );
      expect(
        json.nodes.find(
          (node: { name?: string }) => node.name === "EquipmentWrapper",
        ).extras.hyperia.gripContact,
      ).toEqual(preserved.gripContact);
    }
    expect(
      createHash("sha256")
        .update(
          readFileSync(path.join(workspaceRoot, definition.equipment.path)),
        )
        .digest("hex"),
    ).toBe(definition.equipment.sha256);
  });

  for (const [name, mutate, message] of [
    [
      "source hash drift",
      (value: KnightShortswordGripDefinition) => {
        value.equipment.sha256 = "0".repeat(64);
      },
      "SHA-256 drifted",
    ],
    [
      "wrong hand",
      (value: KnightShortswordGripDefinition) => {
        value.avatar.rawHandNode = "wrist.l";
      },
      "VRM hand mapping",
    ],
    [
      "overlapping region",
      (value: KnightShortswordGripDefinition) => {
        value.sourceTriangleRegions.pommel.push([0, 0]);
      },
      "regions overlap",
    ],
    [
      "missing region",
      (value: KnightShortswordGripDefinition) => {
        value.sourceTriangleRegions.handle[0][0] = 1;
      },
      "complete sword",
    ],
    [
      "reversed action axis",
      (value: KnightShortswordGripDefinition) => {
        value.equipment.sourceAxis = [0, -1, 0];
      },
      "independently separated",
    ],
    [
      "nonfinite avatar height",
      (value: KnightShortswordGripDefinition) => {
        value.avatar.normalizedHeightMetres = Infinity;
      },
      "identity",
    ],
  ] as const) {
    test(`fails closed for ${name}`, async () => {
      const changed = structuredClone(definition);
      mutate(changed);
      await expect(
        measureKaykitShortswordGrip({ workspaceRoot, definition: changed }),
      ).rejects.toThrow(message);
    });
  }
  test("rejects ambiguous or unsupported placement modes", async () => {
    await expect(
      measureKaykitShortswordGrip({
        workspaceRoot,
        definition,
        seatHandleAgainstSurface: true,
      }),
    ).rejects.toThrow("requires");
    await expect(
      measureKaykitShortswordGrip({
        workspaceRoot,
        definition,
        alignHandleToAuthoredSocket: true,
        useAuthoredSocketOrientation: true,
      }),
    ).rejects.toThrow("mutually exclusive");
    const drifted = structuredClone(seated);
    drifted.inputs.avatar.sha256 = "0".repeat(64);
    expect(() =>
      buildKnightShortswordGripCandidate({
        workspaceRoot,
        definition,
        measurement: drifted,
      }),
    ).toThrow("identity drifted");
  });

  test("isolated generation is reproducible, validates audit inputs, and never overwrites conflicting evidence", async () => {
    const fixtureRoot = mkdtempSync(
      path.join(os.tmpdir(), "knight-shortsword-evidence-"),
    );
    try {
      for (const relative of [
        definition.avatar.path,
        definition.equipment.path,
        definition.equipment.sourcePath,
        "scripts/kaykit-shortsword-semantic-grip-definition.json",
        ...[
          "emote-one-hand-idle-steve.glb",
          "emote-one-hand-walk-steve.glb",
          "emote-one-hand-run-steve.glb",
          "emote_sword_swing.glb",
        ].map((file) => `packages/server/world/assets/emotes/${file}`),
      ]) {
        const destination = path.join(fixtureRoot, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(path.join(workspaceRoot, relative), destination);
      }
      const generated = await generateKnightShortswordGripEvidence(
        fixtureRoot,
        definition,
      );
      const repeated = await generateKnightShortswordGripEvidence(
        fixtureRoot,
        definition,
      );
      expect(repeated).toEqual(generated);
      expect(generated.productApproved).toBe(false);
      expect(generated.candidates).toHaveLength(2);
      for (const entry of generated.files) {
        expect(
          entry.path.startsWith(
            "artifacts/duel-launch-avatar-bakeoff/kaykit-shortsword-contact-20260905/",
          ) ||
            entry.path.startsWith(
              "packages/server/world/assets/models/candidates/kaykit-shortsword-contact-20260905/",
            ),
        ).toBe(true);
        const bytes = readFileSync(path.join(fixtureRoot, entry.path));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          entry.sha256,
        );
        if (entry.path.endsWith("equipment-set.json"))
          expect(
            validateDuelMotionEquipmentSetManifest(
              JSON.parse(bytes.toString("utf8")),
            ).equipments[0].avatarId,
          ).toBe("kaykit-knight");
        if (entry.path.endsWith("audit.json")) {
          const audit = JSON.parse(bytes.toString("utf8")) as {
            motions: unknown[];
          };
          expect(audit.motions.length).toBe(
            entry.path.includes("close") ? 8 : 12,
          );
          expect(audit.motions.every(validateDuelAvatarMotionDefinition)).toBe(
            true,
          );
        }
      }
      expect(
        readFileSync(path.join(fixtureRoot, definition.equipment.path)).equals(
          readFileSync(path.join(workspaceRoot, definition.equipment.path)),
        ),
      ).toBe(true);
      const first = path.join(fixtureRoot, generated.files[0].path);
      writeFileSync(first, "retained existing evidence\n");
      const absent = path.join(
        fixtureRoot,
        generated.candidates[0].candidatePath,
      );
      rmSync(absent);
      await expect(
        generateKnightShortswordGripEvidence(fixtureRoot, definition),
      ).rejects.toThrow("Refusing to overwrite");
      expect(readFileSync(first, "utf8")).toBe("retained existing evidence\n");
      expect(existsSync(absent)).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
