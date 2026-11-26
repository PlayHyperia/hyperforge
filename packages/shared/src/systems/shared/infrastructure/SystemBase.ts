/**
 * SystemBase - Enhanced Base Class for Game Systems
 *
 * Extends System with common functionality to eliminate boilerplate code.
 * Use this instead of System for most game systems.
 *
 * **Added Features** (vs System):
 *
 * **Automatic Resource Cleanup**:
 * - Managed timers (auto-cleared on destroy)
 * - Managed intervals (auto-cleared on destroy)
 * - Event subscriptions (auto-unsubscribed on destroy)
 * - No more cleanup bugs!
 *
 * **Type-Safe Event Handling**:
 * - `subscribe<EventType>()` - Strongly typed event subscriptions
 * - `subscribeOnce<EventType>()` - One-time event handlers
 * - `emitTypedEvent()` - Type-checked event emissions
 * - `request/respond()` - Request-response pattern
 *
 * **Built-in Logging**:
 * - SystemLogger instance with automatic prefixing
 * - Consistent log formatting across systems
 * - Debug, info, warn, error methods
 *
 * **Configuration Support**:
 * - SystemConfig parameter in constructor
 * - Standardized system metadata
 * - Dependency declarations
 * - Auto-cleanup settings
 *
 * **EventBus Integration**:
 * - Direct access to world's EventBus
 * - Type-safe event subscriptions
 * - Automatic subscription cleanup
 *
 * **Usage Pattern**:
 * ```typescript
 * class MySystem extends SystemBase {
 *   constructor(world: World) {
 *     super(world, {
 *       name: 'my-system',
 *       dependencies: {
 *         required: ['physics'],
 *         optional: ['audio']
 *       },
 *       autoCleanup: true
 *     });
 *   }
 *
 *   async init() {
 *     // Subscribe to events (auto-cleanup on destroy)
 *     this.subscribe(EventType.ENTITY_SPAWNED, (data) => {
 *       this.logger.info('Entity spawned:', data.entityId);
 *     });
 *
 *     // Create managed timer (auto-cleared on destroy)
 *     this.createTimer(() => {
 *       this.logger.info('Timer fired');
 *     }, 1000);
 *   }
 *
 *   fixedUpdate(delta: number) {
 *     // Your game logic here
 *   }
 * }
 * ```
 *
 * **Benefits**:
 * - Prevents memory leaks (automatic cleanup)
 * - Reduces boilerplate (no manual timer/listener management)
 * - Type safety (compile-time event checking)
 * - Consistency (all systems log and handle events the same way)
 *
 * **Runs on**: Client, Server, or Both (depends on system)
 * **Referenced by**: All modern game systems (CombatSystem, InventorySystem, etc.)
 *
 * @public
 */

import { EventBus, EventSubscription, SystemEvent } from "./EventBus";
import { System } from "./System";
import type { AnyEvent } from "../../../types/events";
import type { World } from "../../../types/index";
import { SystemConfig } from "../../../types/core/core";
import { SystemLogger } from "../../../utils/Logger";
import type {
  EventMap,
  ProcessingProgressPhase,
  ProcessingRejectionReason,
  ProcessingSkill,
} from "../../../types/events";
import {
  EventType,
  getProcessingRequestOperationId,
} from "../../../types/events";

/** Six seconds at the authoritative 600 ms game tick. */
const PROCESSING_PROGRESS_HEARTBEAT_TICKS = 10;

/**
 * SystemBase - Enhanced system base class with automatic resource management
 *
 * @public
 */
export abstract class SystemBase extends System {
  protected readonly systemName: string;
  protected readonly config: SystemConfig;
  protected readonly logger: SystemLogger;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly intervals = new Set<ReturnType<typeof setInterval>>();
  private readonly eventSubscriptions = new Set<EventSubscription>();
  private readonly processingProgressTicks = new Map<string, number>();
  protected readonly eventBus: EventBus;

  constructor(world: World, config: SystemConfig) {
    super(world);
    this.systemName = config.name;
    this.config = config;
    this.logger = new SystemLogger(this.systemName);

    // Initialize event bus - world always has $eventBus
    world.$eventBus = world.$eventBus || new EventBus();
    this.eventBus = world.$eventBus;
  }

  /**
   * Creates a managed timer that automatically cleans up on system destroy
   *
   * Use this instead of setTimeout() to prevent memory leaks.
   *
   * @param callback - Function to call when timer fires
   * @param delay - Delay in milliseconds
   * @returns Timer handle (can be passed to clearTimeout if needed)
   *
   * @example
   * ```typescript
   * this.createTimer(() => {
   *   console.log('Timer fired!');
   * }, 5000); // Fires after 5 seconds
   * ```
   *
   * @protected
   */
  protected createTimer(
    callback: () => void,
    delay: number,
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delay);
    this.timers.add(timer);
    return timer;
  }

  /**
   * Creates a managed interval that automatically cleans up on system destroy
   *
   * Use this instead of setInterval() to prevent memory leaks.
   *
   * @param callback - Function to call on each interval
   * @param delay - Delay between calls in milliseconds
   * @returns Interval handle (can be passed to clearInterval if needed)
   *
   * @example
   * ```typescript
   * this.createInterval(() => {
   *   this.logger.info('Heartbeat');
   * }, 1000); // Every second
   * ```
   *
   * @protected
   */
  protected createInterval(
    callback: () => void,
    delay: number,
  ): NodeJS.Timeout {
    const interval = setInterval(callback, delay);
    this.intervals.add(interval);
    return interval;
  }

  /**
   * Subscribes to an event with automatic cleanup on system destroy
   *
   * Type-safe event subscription that automatically unsubscribes when the system
   * is destroyed. Use this instead of world.on() to prevent memory leaks.
   *
   * @param eventType - Event type to listen for (e.g., EventType.ENTITY_SPAWNED)
   * @param handler - Callback function that receives event data
   * @returns Subscription object (can call unsubscribe() manually if needed)
   *
   * @example
   * ```typescript
   * // Typed event (autocomplete + type checking)
   * this.subscribe(EventType.COMBAT_DAMAGE, (data) => {
   *   this.logger.info(`Damage dealt: ${data.damage}`);
   * });
   *
   * // Custom event
   * this.subscribe('my:custom:event', (data: MyEventData) => {
   *   // Handle custom event
   * });
   * ```
   *
   * @protected
   */
  protected subscribe<K extends keyof EventMap>(
    eventType: K,
    handler: (data: EventMap[K]) => void | Promise<void>,
  ): EventSubscription;
  protected subscribe<T = AnyEvent>(
    eventType: string,
    handler: (data: T) => void | Promise<void>,
  ): EventSubscription;
  protected subscribe<K extends keyof EventMap, T = AnyEvent>(
    eventType: K | string,
    handler:
      | ((data: EventMap[K]) => void | Promise<void>)
      | ((data: T) => void | Promise<void>),
  ): EventSubscription {
    const isTypedEvent = Object.values(EventType).includes(
      eventType as EventType,
    );
    if (isTypedEvent) {
      // For known events, deliver handler the payload directly
      const subscription = this.eventBus.subscribe(
        eventType as string,
        (event: SystemEvent<AnyEvent>) =>
          (handler as (data: AnyEvent) => void | Promise<void>)(event.data),
      );
      this.eventSubscriptions.add(subscription);
      return subscription;
    }
    const subscription = this.eventBus.subscribe(
      eventType as string,
      (event: SystemEvent<AnyEvent>) =>
        (handler as (data: AnyEvent) => void | Promise<void>)(event.data),
    );
    this.eventSubscriptions.add(subscription);
    return subscription;
  }

  /**
   * Protected helper to subscribe to events once with auto-cleanup (strongly typed)
   */
  protected subscribeOnce<K extends keyof EventMap>(
    eventType: K,
    handler: (data: EventMap[K]) => void | Promise<void>,
  ): EventSubscription;
  protected subscribeOnce<T = AnyEvent>(
    eventType: string,
    handler: (data: T) => void | Promise<void>,
  ): EventSubscription;
  protected subscribeOnce<K extends keyof EventMap, T = AnyEvent>(
    eventType: K | string,
    handler:
      | ((data: EventMap[K]) => void | Promise<void>)
      | ((data: T) => void | Promise<void>),
  ): EventSubscription {
    const isTypedEvent = Object.values(EventType).includes(
      eventType as EventType,
    );
    if (isTypedEvent) {
      const subscription = this.eventBus.subscribeOnce(
        eventType as string,
        (event: SystemEvent<AnyEvent>) =>
          (handler as (data: AnyEvent) => void | Promise<void>)(event.data),
      );
      this.eventSubscriptions.add(subscription);
      return subscription;
    }
    const subscription = this.eventBus.subscribeOnce(
      eventType as string,
      (event: SystemEvent<AnyEvent>) =>
        (handler as (data: AnyEvent) => void | Promise<void>)(event.data),
    );
    this.eventSubscriptions.add(subscription);
    return subscription;
  }

  /**
   * Protected helper to emit typed events
   */
  protected emitTypedEvent<K extends keyof EventMap>(
    eventType: K,
    data: EventMap[K],
  ): void;
  protected emitTypedEvent(eventType: string, data: AnyEvent): void;
  protected emitTypedEvent(eventType: string, data: AnyEvent): void {
    this.eventBus.emitEvent(eventType, data, this.systemName);
  }

  /**
   * End a caller-correlated processing request without leaking internal errors.
   * Legacy requests do not carry an identity and retain their prior UI-only
   * rejection behavior.
   */
  protected rejectProcessingRequest(
    playerId: string,
    requestId: string | undefined,
    skill: ProcessingSkill,
    reason: ProcessingRejectionReason,
    retryable = false,
  ): void {
    if (!requestId) return;
    this.processingProgressTicks.delete(requestId);
    const emitRejection = (
      emittedReason: ProcessingRejectionReason,
      emittedRetryable: boolean,
    ): void => {
      this.emitTypedEvent(EventType.PROCESSING_REQUEST_REJECTED, {
        playerId,
        requestId,
        skill,
        reason: emittedReason,
        retryable: emittedRetryable,
      });
    };
    const operationId = getProcessingRequestOperationId(skill, requestId);
    const database = this.world.getSystem("database") as
      | {
          rejectProcessingRequestAsync?: (
            playerId: string,
            operationId: string,
            requestId: string,
            skill: ProcessingSkill,
            reason: ProcessingRejectionReason,
            retryable: boolean,
          ) => Promise<boolean>;
        }
      | undefined;
    if (operationId && database?.rejectProcessingRequestAsync) {
      void database
        .rejectProcessingRequestAsync(
          playerId,
          operationId,
          requestId,
          skill,
          reason,
          retryable,
        )
        .then((rejected) => {
          // Only the durable owner may publish a terminal rejection. A stale
          // server epoch that lost ownership stays silent.
          if (rejected) emitRejection(reason, retryable);
        })
        .catch(() => {
          emitRejection("persistence_rejected", true);
        });
      return;
    }
    emitRejection(reason, retryable);
  }

  /**
   * Confirm that authority still owns a caller-correlated processing request.
   * Repeated calls are tick-throttled so a hung or reconciling transaction can
   * keep the caller safe without creating per-frame network traffic.
   */
  protected reportProcessingRequestProgress(
    playerId: string,
    requestId: string | undefined,
    skill: ProcessingSkill,
    phase: ProcessingProgressPhase,
    force = false,
  ): void {
    if (!requestId) return;
    const currentTick = this.world.currentTick ?? 0;
    const lastTick = this.processingProgressTicks.get(requestId);
    if (
      !force &&
      lastTick !== undefined &&
      currentTick - lastTick < PROCESSING_PROGRESS_HEARTBEAT_TICKS
    ) {
      return;
    }
    this.processingProgressTicks.set(requestId, currentTick);
    const operationId = getProcessingRequestOperationId(skill, requestId);
    const database = this.world.getSystem("database") as
      | {
          heartbeatProcessingRequestAsync?: (
            playerId: string,
            operationId: string,
            requestId: string,
            skill: ProcessingSkill,
          ) => Promise<boolean>;
        }
      | undefined;
    if (operationId && database?.heartbeatProcessingRequestAsync) {
      void database
        .heartbeatProcessingRequestAsync(
          playerId,
          operationId,
          requestId,
          skill,
        )
        .then((owned) => {
          if (!owned) return;
          this.emitTypedEvent(EventType.PROCESSING_REQUEST_PROGRESS, {
            playerId,
            requestId,
            skill,
            phase,
          });
        })
        .catch(() => {});
      return;
    }
    this.emitTypedEvent(EventType.PROCESSING_REQUEST_PROGRESS, {
      playerId,
      requestId,
      skill,
      phase,
    });
  }

  /** Remove liveness bookkeeping after an authoritative completion event. */
  protected finishProcessingRequest(requestId: string | undefined): void {
    if (requestId) this.processingProgressTicks.delete(requestId);
  }

  /**
   * Protected helper for request-response pattern
   */
  protected async request<
    TRequest extends AnyEvent = AnyEvent,
    TResponse extends AnyEvent = AnyEvent,
  >(requestType: string, data: TRequest, timeout?: number): Promise<TResponse> {
    return this.eventBus.request<TRequest, TResponse>(
      requestType,
      data,
      this.systemName,
      timeout,
    );
  }

  /**
   * Protected helper to respond to requests
   */
  protected respond<T extends AnyEvent = AnyEvent>(
    originalEvent: SystemEvent<{ _responseType?: string; _requestId?: string }>,
    responseData: T,
  ): void {
    this.eventBus.respond<T>(originalEvent, responseData, this.systemName);
  }

  /**
   * Override this for custom cleanup logic
   * Base implementation handles timers, intervals, and event listeners
   */
  destroy(): void {
    // Clear all managed timers
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();

    // Clear all managed intervals
    this.intervals.forEach((interval) => clearInterval(interval));
    this.intervals.clear();

    // Remove all event subscriptions
    this.eventSubscriptions.forEach((subscription) => {
      subscription.unsubscribe();
    });
    this.eventSubscriptions.clear();
    this.processingProgressTicks.clear();

    // Call parent cleanup
    super.destroy();
  }

  // Default implementations - systems only override what they need
  preTick(): void {
    // Default: do nothing
  }

  preFixedUpdate(_willFixedStep: boolean): void {
    // Default: do nothing
  }

  fixedUpdate(_dt: number): void {
    // Default: do nothing
  }

  postFixedUpdate(_dt: number): void {
    // Default: do nothing
  }

  preUpdate(_alpha: number): void {
    // Default: do nothing
  }

  update(_dt: number): void {
    // Default: do nothing
  }

  postUpdate(_dt: number): void {
    // Default: do nothing
  }

  lateUpdate(_dt: number): void {
    // Default: do nothing
  }

  postLateUpdate(_dt: number): void {
    // Default: do nothing
  }

  commit(): void {
    // Default: do nothing
  }

  postTick(): void {
    // Default: do nothing
  }
}
