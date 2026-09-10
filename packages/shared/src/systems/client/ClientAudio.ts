/**
 * ClientAudio.ts - 3D Positional Audio System
 *
 * Manages spatial audio playback with 3D positioning and distance attenuation.
 * Provides music, sound effects, and voice chat audio mixing.
 *
 * Key Features:
 * - **3D Spatial Audio**: Sound positioned in 3D space with distance falloff
 * - **Audio Groups**: Separate volume controls for music, SFX, and voice
 * - **Auto-Unlock**: Handles browser autoplay restrictions
 * - **Audio Listener**: Synced with camera position and orientation
 * - **Performance**: Efficient audio queue and context management
 * - **Web Audio API**: High-performance browser audio
 *
 * Audio Groups:
 * - **Music**: Background music and ambient tracks
 * - **SFX**: Sound effects (combat, footsteps, interactions)
 * - **Voice**: Voice chat and NPC dialogue
 *
 * Each group has independent volume control and connects through a master gain node.
 *
 * Spatial Audio:
 * - Sounds have position in 3D world
 * - Volume decreases with distance from listener
 * - Panning based on left/right position
 * - Doppler effect for moving sources (optional)
 * - Reverb and occlusion (future)
 *
 * Distance Attenuation:
 * - Linear falloff: Volume drops linearly with distance
 * - Exponential falloff: More realistic distance model
 * - Max distance: Sounds silent beyond this
 * - Ref distance: Distance at full volume
 *
 * Browser Autoplay:
 * - Modern browsers block audio until user interaction
 * - System queues sounds until audio context unlocked
 * - First click/tap unlocks audio
 * - Automatically plays queued sounds
 *
 * Audio Listener:
 * - Positioned at camera location
 * - Oriented with camera direction
 * - Updated every frame in tick()
 * - Uses AudioContext.listener API
 *
 * Performance:
 * - Reuses AudioBuffers across multiple sources
 * - Stops inaudible sounds automatically
 * - Limits concurrent sounds (culling)
 * - Pre-loads frequently used sounds
 *
 * Usage:
 * ```typescript
 * // Play 2D sound (music, UI)
 * world.audio.play2D('music/background.mp3', 'music');
 *
 * // Play 3D positional sound
 * world.audio.play3D('sfx/footstep.mp3', {
 *   position: { x: 5, y: 0, z: 10 },
 *   volume: 0.8,
 *   refDistance: 5,
 *   maxDistance: 50
 * });
 *
 * // Adjust volumes
 * world.audio.setMusicVolume(0.5);
 * world.audio.setSFXVolume(0.8);
 * world.audio.setVoiceVolume(1.0);
 * ```
 *
 * Related Systems:
 * - ClientLiveKit: Voice chat audio routing
 * - MusicSystem: Background music management
 * - ClientCameraSystem: Audio listener position
 * - Entities: Sound emitters attached to entities
 *
 * Dependencies:
 * - Web Audio API (browser native)
 * - three.js Audio classes
 * - User preferences for volume
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
 */

import * as THREE from "../../extras/three/three";

import { System } from "../shared/infrastructure/System";
import type { World, AudioGroupGains } from "../../types";

const up = new THREE.Vector3(0, 1, 0);
const v1 = new THREE.Vector3();

type SilentSinkAudioContext = {
  setSinkId?: (sinkId: { type: "none" }) => Promise<void>;
};

/**
 * Route a dedicated streaming AudioContext to Chrome's clocked, inaudible
 * output sink. A normal device-backed context can report `running` while its
 * currentTime and AudioWorklets remain stalled in an automated browser.
 */
export async function activateSilentStreamingAudioSink(
  context: AudioContext,
): Promise<void> {
  const sinkContext = context as unknown as SilentSinkAudioContext;
  if (typeof sinkContext.setSinkId !== "function") {
    throw new Error("Streaming audio requires a clocked silent output sink");
  }
  await sinkContext.setSinkId({ type: "none" });
}

/**
 * Client Audio System
 *
 * Manages 3D spatial audio and sound effects.
 * Runs only on client (browser).
 */
export class ClientAudio extends System {
  ctx: AudioContext;
  masterGain: GainNode;
  groupGains: AudioGroupGains;
  audioListener: AudioListener;
  lastDelta: number;
  queue: Array<() => void>;
  unlocked: boolean;
  private unlockHandler: (() => Promise<void>) | null = null;
  private captureDestination: ReturnType<
    AudioContext["createMediaStreamDestination"]
  > | null = null;
  private streamingCapturePilot: ReturnType<
    AudioContext["createOscillator"]
  > | null = null;
  private streamingCapturePilotGain: GainNode | null = null;
  private streamingCaptureLocalOutputDisconnected = false;
  private streamingCaptureSilentSinkActive = false;

  constructor(world: World) {
    super(world);
    this.ctx = new AudioContext(); // new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
    this.groupGains = {
      music: this.ctx.createGain(),
      sfx: this.ctx.createGain(),
      voice: this.ctx.createGain(),
    };
    this.groupGains.music.gain.value = world.prefs?.music || 0.5;
    this.groupGains.sfx.gain.value = world.prefs?.sfx || 0.5;
    this.groupGains.voice.gain.value = world.prefs?.voice || 0.5;
    this.groupGains.music.connect(this.masterGain);
    this.groupGains.sfx.connect(this.masterGain);
    this.groupGains.voice.connect(this.masterGain);
    this.audioListener = this.ctx.listener;
    this.audioListener.positionX.value = 0;
    this.audioListener.positionY.value = 0;
    this.audioListener.positionZ.value = 0;
    this.audioListener.forwardX.value = 0;
    this.audioListener.forwardY.value = 0;
    this.audioListener.forwardZ.value = -1;
    this.audioListener.upX.value = 0;
    this.audioListener.upY.value = 1;
    this.audioListener.upZ.value = 0;
    this.lastDelta = 0;

    this.queue = [];
    this.unlocked = this.ctx.state !== "suspended";
    if (!this.unlocked) {
      this.setupUnlockListener();
    }
  }

  getContext(): AudioContext {
    return this.ctx;
  }

  getVoiceGain(): GainNode {
    return this.groupGains.voice;
  }

  /**
   * Return an isolated copy of the final game mix for the canonical stream
   * encoder. The destination is created lazily so ordinary game clients pay
   * no capture cost, and it contains only audio already routed through the
   * game's master bus (never a microphone or unrelated system audio).
   */
  getOutputCaptureStream(): MediaStream {
    if (
      this.captureDestination?.stream
        .getAudioTracks()
        .some((track) => track.readyState === "ended")
    ) {
      this.captureDestination.disconnect();
      this.captureDestination = null;
    }
    if (!this.captureDestination) {
      this.captureDestination = this.ctx.createMediaStreamDestination();
      this.masterGain.connect(this.captureDestination);
    }
    return this.captureDestination.stream;
  }

  /** Return the final post-group master bus for the trusted stream renderer. */
  getOutputCaptureNode(): GainNode {
    return this.masterGain;
  }

  ready(fn: () => void) {
    if (this.unlocked) return fn();
    this.queue.push(fn);
  }

  private completeUnlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    this.removeUnlockListeners();
    while (this.queue.length) {
      const fn = this.queue.pop();
      if (fn) fn();
    }
  }

  /**
   * Activate audio for the dedicated broadcast renderer. Ordinary players
   * still require a user gesture; this method succeeds only in the isolated
   * capture browser launched with an explicit autoplay policy. Draining the
   * same readiness queue ensures the encoded master mix contains the real
   * game music and effects instead of an encoder-generated silent fallback.
   */
  async activateForStreamingCapture(): Promise<void> {
    if (this.ctx.state === "closed") {
      throw new Error("AudioContext is closed, cannot activate stream audio");
    }
    if (!this.streamingCaptureLocalOutputDisconnected) {
      // The isolated renderer needs Chromium's audio render clock, but it must
      // not play the game mix through the host Mac's speakers. The capture
      // destination and trusted AudioWorklet remain connected to masterGain.
      this.masterGain.disconnect(this.ctx.destination);
      this.streamingCaptureLocalOutputDisconnected = true;
    }
    if (!this.streamingCaptureSilentSinkActive) {
      await activateSilentStreamingAudioSink(this.ctx);
      this.streamingCaptureSilentSinkActive = true;
    }
    if (this.ctx.state !== "running") {
      await this.ctx.resume();
    }
    if (this.ctx.state !== "running") {
      throw new Error(`Stream audio remained ${this.ctx.state}`);
    }
    this.completeUnlock();
    if (!this.streamingCapturePilot) {
      // Keep Chromium's pull-based graph rendering the master tap during
      // momentary gaps between music/SFX. At 1e-8 gain this 20 Hz continuity
      // pilot is far below audibility and is not accepted as content by the
      // broadcast audio health gate.
      this.streamingCapturePilot = this.ctx.createOscillator();
      this.streamingCapturePilotGain = this.ctx.createGain();
      this.streamingCapturePilot.frequency.value = 20;
      this.streamingCapturePilotGain.gain.value = 1e-8;
      this.streamingCapturePilot.connect(this.streamingCapturePilotGain);
      this.streamingCapturePilotGain.connect(this.masterGain);
      this.streamingCapturePilot.start();
    }
  }

  setupUnlockListener() {
    const unlock = async () => {
      // Guard against closed or closing context
      if (this.ctx.state === "closed") {
        console.warn("AudioContext is closed, cannot resume");
        this.removeUnlockListeners();
        return;
      }

      try {
        await this.ctx.resume();
        if (this.ctx.state !== "running")
          throw new Error("Audio still suspended");
        const video = document.createElement("video");
        video.playsInline = true;
        video.muted = true;
        video.src = "/tiny.mp4";
        await video.play();
        video.pause();
        video.remove();
        this.completeUnlock();
      } catch (error) {
        console.error("Failed to unlock audio context:", error);
        this.removeUnlockListeners();
      }
    };

    this.unlockHandler = unlock;
    document.addEventListener("click", unlock);
    document.addEventListener("touchstart", unlock);
    document.addEventListener("keydown", unlock);
  }

  private removeUnlockListeners() {
    if (this.unlockHandler) {
      document.removeEventListener("click", this.unlockHandler);
      document.removeEventListener("touchstart", this.unlockHandler);
      document.removeEventListener("keydown", this.unlockHandler);
      this.unlockHandler = null;
    }
  }

  async init() {
    this.world.prefs!.on("change", this.onPrefsChange);
  }

  start() {
    // ...
  }

  lateUpdate(delta: number) {
    const target = this.world.rig;
    const dir = v1.set(0, 0, -1).applyQuaternion(target.quaternion);
    const endTime = this.ctx.currentTime + delta * 2;
    this.audioListener.positionX.linearRampToValueAtTime(
      target.position.x,
      endTime,
    );
    this.audioListener.positionY.linearRampToValueAtTime(
      target.position.y,
      endTime,
    );
    this.audioListener.positionZ.linearRampToValueAtTime(
      target.position.z,
      endTime,
    );
    this.audioListener.forwardX.linearRampToValueAtTime(dir.x, endTime);
    this.audioListener.forwardY.linearRampToValueAtTime(dir.y, endTime);
    this.audioListener.forwardZ.linearRampToValueAtTime(dir.z, endTime);
    this.audioListener.upX.linearRampToValueAtTime(up.x, endTime);
    this.audioListener.upY.linearRampToValueAtTime(up.y, endTime);
    this.audioListener.upZ.linearRampToValueAtTime(up.z, endTime);
    this.lastDelta = delta * 2;
  }

  onPrefsChange = (changes: {
    music?: { value: number };
    sfx?: { value: number };
    voice?: { value: number };
  }) => {
    if (changes.music) {
      this.groupGains.music.gain.value = changes.music.value;
    }
    if (changes.sfx) {
      this.groupGains.sfx.gain.value = changes.sfx.value;
    }
    if (changes.voice) {
      this.groupGains.voice.gain.value = changes.voice.value;
    }
  };

  destroy() {
    // Remove unlock event listeners first
    this.removeUnlockListeners();

    // Clean up prefs listener
    if (this.world.prefs) {
      this.world.prefs.off("change", this.onPrefsChange);
    }

    // Disconnect audio nodes
    this.groupGains.music.disconnect();
    this.groupGains.sfx.disconnect();
    this.groupGains.voice.disconnect();
    this.masterGain.disconnect();
    try {
      this.streamingCapturePilot?.stop();
    } catch {
      // The pilot may already have stopped with its owning context.
    }
    this.streamingCapturePilot?.disconnect();
    this.streamingCapturePilotGain?.disconnect();
    this.streamingCapturePilot = null;
    this.streamingCapturePilotGain = null;
    this.captureDestination?.disconnect();
    this.captureDestination = null;

    // Close the audio context
    this.ctx.close();

    // Clear the queue
    this.queue = [];
  }
}
