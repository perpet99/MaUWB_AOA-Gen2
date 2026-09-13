/**
 * Closed-loop pan correction: keep a chosen tag centred in the anchor's
 * boresight by nudging the pan-tilt HAT whenever the tag's angle drifts past
 * a dead-band.
 *
 * Runs entirely server-side, fed by `Session`'s decoded frame batches, so
 * tracking keeps working even with no browser tab open.
 */

import { EventEmitter } from 'node:events';

import type { TrackingState, WireFrame } from '@mauwb/protocol';

import { getPanTiltState, movePanTilt, type PanTiltDirection } from './panTilt.js';

const DEFAULT_THRESHOLD_DEG = 10;
const DEFAULT_STEP_DEG = 10;
const DEFAULT_COOLDOWN_MS = 400;
/** No LOC frame for the tracked tag within this window counts as lost. */
const STALE_MS = 1500;
const STALE_POLL_MS = 500;

export interface TrackingOptions {
  thresholdDeg?: number;
  stepDeg?: number;
  cooldownMs?: number;
}

export interface TrackerEvents {
  state: (state: TrackingState) => void;
  notice: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class Tracker extends EventEmitter {
  private active = false;
  private tagAddr: number | null = null;
  private thresholdDeg = DEFAULT_THRESHOLD_DEG;
  private stepDeg = DEFAULT_STEP_DEG;
  private cooldownMs = DEFAULT_COOLDOWN_MS;

  private lastAngleDeg: number | null = null;
  private lastSeenAt = 0;
  private lastCorrectionAt = 0;
  private lastKnownPan: number | null = null;
  private panLimitReached = false;
  private correcting = false;
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  override on<K extends keyof TrackerEvents>(event: K, listener: TrackerEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof TrackerEvents>(
    event: K,
    ...args: Parameters<TrackerEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  get state(): TrackingState {
    return {
      active: this.active,
      tagAddr: this.tagAddr,
      thresholdDeg: this.thresholdDeg,
      stepDeg: this.stepDeg,
      cooldownMs: this.cooldownMs,
      lastAngleDeg: this.lastAngleDeg,
      lastCorrectionAt: this.lastCorrectionAt || null,
      stale: this.active ? Date.now() - this.lastSeenAt > STALE_MS : false,
      panLimitReached: this.panLimitReached,
    };
  }

  async start(tagAddr: number, opts: TrackingOptions = {}): Promise<TrackingState> {
    this.tagAddr = tagAddr;
    this.thresholdDeg = opts.thresholdDeg ?? DEFAULT_THRESHOLD_DEG;
    this.stepDeg = opts.stepDeg ?? DEFAULT_STEP_DEG;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.active = true;
    this.lastAngleDeg = null;
    this.lastSeenAt = Date.now();
    this.lastCorrectionAt = 0;
    this.panLimitReached = false;

    const panTilt = await getPanTiltState();
    this.lastKnownPan = panTilt.pan;

    this.stopStaleWatch();
    this.staleTimer = setInterval(() => this.publish(), STALE_POLL_MS);
    this.publish();
    return this.state;
  }

  stop(): TrackingState {
    this.active = false;
    this.tagAddr = null;
    this.stopStaleWatch();
    this.publish();
    return this.state;
  }

  private stopStaleWatch(): void {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = null;
  }

  private publish(): void {
    this.emit('state', this.state);
  }

  /** Feed every batch of decoded frames the session hands to WS subscribers. */
  onFrames(frames: WireFrame[]): void {
    if (!this.active || this.tagAddr === null) return;

    let sawFrame = false;
    for (const f of frames) {
      if (f.kind !== 'loc' || f.tagAddr16 !== this.tagAddr) continue;
      const anchor = f.anchors.find((a) => a.valid);
      if (!anchor) continue;
      sawFrame = true;
      this.lastAngleDeg = anchor.angleDeg;
      this.lastSeenAt = Date.now();
      this.maybeCorrect(anchor.angleDeg);
    }
    if (sawFrame) this.publish();
  }

  private maybeCorrect(angleDeg: number): void {
    if (this.correcting) return;
    if (Date.now() - this.lastCorrectionAt < this.cooldownMs) return;
    if (Math.abs(angleDeg) < this.thresholdDeg) return;

    const direction: PanTiltDirection = angleDeg > 0 ? 'right' : 'left';
    const before = this.lastKnownPan;
    this.lastCorrectionAt = Date.now();
    this.correcting = true;

    movePanTilt(direction, this.stepDeg)
      .then((panTilt) => {
        const pinned = before !== null && panTilt.pan === before;
        if (pinned !== this.panLimitReached) {
          this.panLimitReached = pinned;
          if (pinned) this.emit('notice', 'warn', 'Pan-tilt reached its limit -- tag may be out of range.');
        }
        this.lastKnownPan = panTilt.pan;
        this.publish();
      })
      .catch((err) => {
        this.emit('notice', 'error', `tracking correction failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.correcting = false;
      });
  }
}
