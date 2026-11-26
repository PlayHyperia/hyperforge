import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../systems/StreamingDuelScheduler/index.js", () => ({
  getStreamingDuelScheduler: () => null,
}));

vi.mock("../../systems/ServerNetwork/services/Logger.js", () => ({
  Logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  exitMaintenanceMode,
  getMaintenanceStatus,
  isMaintenanceModeActive,
} from "../maintenance-mode.js";

describe("maintenance mode restart continuity", () => {
  afterEach(() => {
    exitMaintenanceMode();
    delete process.env.STREAMING_DUEL_MAINTENANCE_MODE;
  });

  it("reports an inherited environment startup gate as active", () => {
    process.env.STREAMING_DUEL_MAINTENANCE_MODE = "true";

    expect(isMaintenanceModeActive()).toBe(true);
    expect(getMaintenanceStatus()).toMatchObject({
      active: true,
      safeToDeploy: true,
    });
  });

  it("releases an inherited environment startup gate after a cold restart", () => {
    process.env.STREAMING_DUEL_MAINTENANCE_MODE = "true";

    const status = exitMaintenanceMode();

    expect(process.env.STREAMING_DUEL_MAINTENANCE_MODE).toBeUndefined();
    expect(isMaintenanceModeActive()).toBe(false);
    expect(status).toMatchObject({
      active: false,
      safeToDeploy: false,
    });
  });
});
