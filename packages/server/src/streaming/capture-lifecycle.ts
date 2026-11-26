export const CAPTURE_LIFECYCLE_STAGES = [
  "process_starting",
  "bridge_starting",
  "browser_launching",
  "page_loading",
  "renderer_waiting",
  "renderer_ready",
  "capture_warmup",
  "capture_starting",
  "streaming",
  "failed",
] as const;

export type CaptureLifecycleStage = (typeof CAPTURE_LIFECYCLE_STAGES)[number];

export interface CaptureLifecycleTransition {
  stage: CaptureLifecycleStage;
  at: number;
}

export interface CaptureLifecycleSnapshot {
  processId: number;
  processStartedAt: number;
  stage: CaptureLifecycleStage;
  stageStartedAt: number;
  updatedAt: number;
  transitions: CaptureLifecycleTransition[];
}

const MAX_RETAINED_TRANSITIONS = 16;

function normalizeTimestamp(value: number, floor: number): number {
  if (!Number.isFinite(value)) return floor;
  return Math.max(floor, Math.trunc(value));
}

/**
 * Retains a bounded, monotonic startup timeline for the supervised capture
 * worker. The snapshot contains no URLs, credentials, or arbitrary messages,
 * so it is safe to persist beside the allowlisted runtime status payload.
 */
export class CaptureLifecycleTracker {
  private readonly processId: number;
  private readonly processStartedAt: number;
  private transitions: CaptureLifecycleTransition[];

  constructor(processId: number, startedAt: number = Date.now()) {
    this.processId = Math.max(0, Math.trunc(processId));
    this.processStartedAt = normalizeTimestamp(startedAt, 0);
    this.transitions = [
      { stage: "process_starting", at: this.processStartedAt },
    ];
  }

  transition(
    stage: CaptureLifecycleStage,
    observedAt: number = Date.now(),
  ): CaptureLifecycleSnapshot {
    const previous = this.transitions[this.transitions.length - 1];
    const at = normalizeTimestamp(
      observedAt,
      previous?.at ?? this.processStartedAt,
    );

    if (previous?.stage !== stage) {
      this.transitions.push({ stage, at });
      if (this.transitions.length > MAX_RETAINED_TRANSITIONS) {
        this.transitions = this.transitions.slice(-MAX_RETAINED_TRANSITIONS);
      }
    }

    return this.snapshot();
  }

  snapshot(): CaptureLifecycleSnapshot {
    const current = this.transitions[this.transitions.length - 1] ?? {
      stage: "process_starting" as const,
      at: this.processStartedAt,
    };
    return {
      processId: this.processId,
      processStartedAt: this.processStartedAt,
      stage: current.stage,
      stageStartedAt: current.at,
      updatedAt: current.at,
      transitions: this.transitions.map((transition) => ({ ...transition })),
    };
  }
}
