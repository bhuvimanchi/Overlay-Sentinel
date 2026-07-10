"use client";

import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import type { GazeSummary } from "@/lib/store";

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

interface GazeSample {
  t: number;
  x: number; // -1..1, positive = candidate's right
  y: number; // -1..1, positive = up
}

// Detection thresholds — mutable so the calibration page can tune them live
// against a real copilot without a rebuild.
export interface GazeConfig {
  driftStepMax: number; // |dx| below this = slow reading drift; above = a jump/saccade
  driftThreshold: number; // accumulated drift before a reversal counts as a reading sweep
  offScreenX: number; // |x| above this = looking off-center horizontally
  offScreenY: number; // |y| above this = looking off-camera vertically
}

export const DEFAULT_GAZE_CONFIG: GazeConfig = {
  driftStepMax: 0.12,
  driftThreshold: 0.18,
  offScreenX: 0.32,
  offScreenY: 0.35,
};

export interface GazeDebug {
  x: number;
  y: number;
  drift: number;
  driftDir: number;
  sweepCount: number;
  windowActive: boolean;
  samples: number;
  offScreenRatio: number; // within the current window
  offScreen: boolean; // this sample
}

// Tracks gaze direction from webcam via FaceLandmarker blendshapes and detects
// two behaviors during an "answer window": sustained off-camera fixation, and
// line-reading sweeps (slow drift then a fast return saccade — the signature of
// reading text line by line).
export class GazeTracker {
  config: GazeConfig = { ...DEFAULT_GAZE_CONFIG };

  private landmarker?: FaceLandmarker;
  private video?: HTMLVideoElement;
  private running = false;
  private lastSampleT = 0;
  private lastDetectT = 0; // MediaPipe requires strictly increasing timestamps
  private faceDetected = false;

  private windowActive = false;
  private samples: GazeSample[] = [];
  private offScreenCount = 0;

  // sweep detection state
  private drift = 0;
  private driftDir = 0;
  private sweepCount = 0;

  onSample?: (x: number, y: number) => void;
  onFaceChange?: (detected: boolean) => void; // fires only on transitions
  onDebug?: (d: GazeDebug) => void; // fires every sample — for the calibration UI

  async start(video: HTMLVideoElement): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
    this.video = video;
    this.running = true;
    // Schedule the first frame instead of running it inline, so a not-yet-ready
    // first frame can never throw out of start().
    requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    if (this.faceDetected) {
      this.faceDetected = false;
      this.onFaceChange?.(false);
    }
    this.landmarker?.close();
  }

  beginAnswerWindow(): void {
    this.windowActive = true;
    this.samples = [];
    this.offScreenCount = 0;
    this.drift = 0;
    this.driftDir = 0;
    this.sweepCount = 0;
  }

  endAnswerWindow(): GazeSummary {
    this.windowActive = false;
    const n = this.samples.length;
    return {
      offScreenRatio: n > 0 ? this.offScreenCount / n : 0,
      sweepCount: this.sweepCount,
      samples: n,
    };
  }

  private isOffScreen(x: number, y: number): boolean {
    return Math.abs(x) > this.config.offScreenX || Math.abs(y) > this.config.offScreenY;
  }

  private loop = () => {
    if (!this.running) return;
    requestAnimationFrame(this.loop);

    // Adaptive rate: CPU face inference is heavy, so only sample fast while
    // the candidate is actually answering (when reading-detection matters).
    // Idle between questions at a low rate to keep the UI responsive for
    // clicks and transitions.
    const now = performance.now();
    const interval = this.windowActive ? 100 : 300; // ~10 Hz answering, ~3 Hz idle
    if (now - this.lastSampleT < interval) return;
    const v = this.video;
    if (!v || !this.landmarker) return;
    // Wait for a real, decoded frame — detectForVideo throws on a 0x0 frame.
    if (v.readyState < 2 || v.videoWidth === 0 || v.videoHeight === 0) return;
    this.lastSampleT = now;

    // Timestamp must strictly increase for the VIDEO running mode.
    const ts = Math.max(now, this.lastDetectT + 1);
    this.lastDetectT = ts;

    let result;
    try {
      result = this.landmarker.detectForVideo(v, ts);
    } catch {
      return; // transient decode/timestamp hiccup — skip this frame, keep looping
    }
    const shapes = result.faceBlendshapes?.[0]?.categories;
    const detected = !!shapes && shapes.length > 0;
    if (detected !== this.faceDetected) {
      this.faceDetected = detected;
      this.onFaceChange?.(detected);
    }
    if (!shapes) return;

    const get = (name: string) =>
      shapes.find((c) => c.categoryName === name)?.score ?? 0;

    const x =
      (get("eyeLookOutRight") + get("eyeLookInLeft")) / 2 -
      (get("eyeLookOutLeft") + get("eyeLookInRight")) / 2;
    const y =
      (get("eyeLookUpLeft") + get("eyeLookUpRight")) / 2 -
      (get("eyeLookDownLeft") + get("eyeLookDownRight")) / 2;

    this.onSample?.(x, y);

    const prev = this.samples[this.samples.length - 1];
    const offScreen = this.isOffScreen(x, y);

    if (this.windowActive) {
      this.samples.push({ t: now, x, y });
      if (offScreen) this.offScreenCount++;

      if (prev) {
        // Sweep detection: slow drift in one direction, then a fast saccade the
        // other way after enough accumulated drift = one line-reading sweep.
        const dx = x - prev.x;
        const dir = Math.sign(dx);
        const c = this.config;
        if (Math.abs(dx) < c.driftStepMax) {
          // slow movement — part of a drift across a line of text
          if (dir === this.driftDir || this.driftDir === 0) {
            if (dir !== 0) this.driftDir = dir;
            this.drift += dx;
          } else {
            this.driftDir = dir;
            this.drift = dx;
          }
        } else {
          // fast movement — a saccade/jump
          if (dir !== 0 && dir !== this.driftDir && Math.abs(this.drift) > c.driftThreshold) {
            this.sweepCount++;
          }
          this.driftDir = dir;
          this.drift = 0;
        }
      }
    }

    this.onDebug?.({
      x,
      y,
      drift: this.drift,
      driftDir: this.driftDir,
      sweepCount: this.sweepCount,
      windowActive: this.windowActive,
      samples: this.samples.length,
      offScreenRatio:
        this.samples.length > 0 ? this.offScreenCount / this.samples.length : 0,
      offScreen,
    });
  };
}
