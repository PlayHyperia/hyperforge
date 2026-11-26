import { readFileSync } from "node:fs";
import { DataManager } from "@hyperforge/shared";

/** Real profile setup for legacy service fixtures; never bypass spawn admission. */
export function loadWorldProfileTestFixture(): void {
  DataManager.setWorldConfig(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../world/assets/manifests/world-config.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Parameters<typeof DataManager.setWorldConfig>[0],
  );
}
