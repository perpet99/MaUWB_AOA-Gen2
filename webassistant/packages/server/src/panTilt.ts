/**
 * Waveshare Pan-Tilt HAT driver: a PCA9685 PWM controller on I2C driving two
 * hobby servos (channel 0 = tilt, channel 1 = pan by the vendor's own
 * convention -- see main.py in
 * https://github.com/waveshare/Pan-Tilt-HAT/tree/master/RaspberryPi/Servo_Driver/python).
 *
 * `i2c-bus` is a native module and, like `serialport`, is an optional
 * dependency: it is imported lazily so TCP/file/camera-only setups without
 * the HAT still work.
 */

const I2C_BUS_NUMBER = Number(process.env.PANTILT_I2C_BUS ?? 1);
const I2C_ADDRESS = Number(process.env.PANTILT_I2C_ADDRESS ?? 0x40);
const PAN_CHANNEL = Number(process.env.PANTILT_PAN_CHANNEL ?? 1);
const TILT_CHANNEL = Number(process.env.PANTILT_TILT_CHANNEL ?? 0);
const PAN_MIN = Number(process.env.PANTILT_PAN_MIN ?? 0);
const PAN_MAX = Number(process.env.PANTILT_PAN_MAX ?? 180);
const TILT_MIN = Number(process.env.PANTILT_TILT_MIN ?? 0);
const TILT_MAX = Number(process.env.PANTILT_TILT_MAX ?? 180);
const CENTER_PAN = clamp(Number(process.env.PANTILT_CENTER_PAN ?? 90), PAN_MIN, PAN_MAX);
const CENTER_TILT = clamp(Number(process.env.PANTILT_CENTER_TILT ?? 90), TILT_MIN, TILT_MAX);
/** Degrees advanced per animation tick -- smaller is smoother, slower. */
const STEP_DEG_PER_TICK = 1;
const TICK_MS = Number(process.env.PANTILT_STEP_MS ?? 15);

const MODE1 = 0x00;
const MODE2 = 0x01;
const PRESCALE = 0xfe;
const LED0_ON_L = 0x06;

export type PanTiltDirection = 'up' | 'down' | 'left' | 'right';

export interface PanTiltState {
  pan: number;
  tilt: number;
  moving: boolean;
  available: boolean;
  error: string | null;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** A blocking delay -- only used once at start-up, per the datasheet's reset timing. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

class PCA9685 {
  constructor(
    private readonly bus: import('i2c-bus').I2CBus,
    private readonly address: number,
  ) {}

  private write(reg: number, value: number): void {
    this.bus.writeByteSync(this.address, reg, value);
  }

  private read(reg: number): number {
    return this.bus.readByteSync(this.address, reg);
  }

  setPWMFreq(freq: number): void {
    const prescaleval = 25_000_000 / 4096 / freq - 1;
    const prescale = Math.floor(prescaleval + 0.5);
    // Read MODE1 only to preserve its non-sleep bits -- a process killed mid-init
    // can leave the chip asleep, and reusing that stale value would keep it
    // asleep forever (register writes still succeed, but PWM output stays dead).
    const baseMode = this.read(MODE1) & 0x7f & ~0x10;
    this.write(MODE1, baseMode | 0x10); // sleep to change the prescaler
    this.write(PRESCALE, prescale);
    this.write(MODE1, baseMode); // wake, sleep bit explicitly cleared
    sleepSync(5);
    this.write(MODE1, baseMode | 0x80); // restart, still with sleep cleared
    this.write(MODE2, 0x04);
  }

  setPWM(channel: number, on: number, off: number): void {
    this.write(LED0_ON_L + 4 * channel, on & 0xff);
    this.write(LED0_ON_L + 1 + 4 * channel, on >> 8);
    this.write(LED0_ON_L + 2 + 4 * channel, off & 0xff);
    this.write(LED0_ON_L + 3 + 4 * channel, off >> 8);
  }

  setRotationAngle(channel: number, angle: number): void {
    const pulseUs = angle * (2000 / 180) + 501;
    const off = Math.round((pulseUs * 4096) / 20000);
    this.setPWM(channel, 0, off);
  }
}

let pwm: PCA9685 | null = null;
let initError: string | null = null;
let initialized = false;

let state: PanTiltState = {
  pan: CENTER_PAN,
  tilt: CENTER_TILT,
  moving: false,
  available: false,
  error: null,
};

let animationTimer: ReturnType<typeof setInterval> | null = null;

async function ensureDriver(): Promise<PCA9685> {
  if (pwm) return pwm;
  if (initError) throw new Error(initError);

  let i2c: typeof import('i2c-bus');
  try {
    i2c = await import('i2c-bus');
  } catch {
    initError =
      'i2c-bus is not installed (it is an optional native dependency). ' +
      'Run "npm install i2c-bus -w @mauwb/server" on the Raspberry Pi.';
    throw new Error(initError);
  }

  try {
    const bus = i2c.openSync(I2C_BUS_NUMBER);
    const driver = new PCA9685(bus, I2C_ADDRESS);
    driver.setPWMFreq(50);
    pwm = driver;
    initialized = true;
    return driver;
  } catch (err) {
    initError = `Unable to open the pan-tilt HAT: ${err instanceof Error ? err.message : String(err)}`;
    throw new Error(initError);
  }
}

function publicState(): PanTiltState {
  return { ...state };
}

/** Animate both servos from their current angle to the given targets, one degree per tick. */
function animateTo(driver: PCA9685, targetPan: number, targetTilt: number): Promise<PanTiltState> {
  if (animationTimer) clearInterval(animationTimer);

  return new Promise((resolve) => {
    state = { ...state, moving: true, available: true, error: null };
    animationTimer = setInterval(() => {
      const panDone = step(state.pan, targetPan) === targetPan;
      const tiltDone = step(state.tilt, targetTilt) === targetTilt;
      state.pan = step(state.pan, targetPan);
      state.tilt = step(state.tilt, targetTilt);
      driver.setRotationAngle(PAN_CHANNEL, state.pan);
      driver.setRotationAngle(TILT_CHANNEL, state.tilt);

      if (panDone && tiltDone) {
        if (animationTimer) clearInterval(animationTimer);
        animationTimer = null;
        state = { ...state, moving: false };
        resolve(publicState());
      }
    }, TICK_MS);
  });
}

function step(current: number, target: number): number {
  if (current === target) return current;
  const delta = target - current;
  const move = Math.sign(delta) * Math.min(STEP_DEG_PER_TICK, Math.abs(delta));
  return current + move;
}

export async function getPanTiltState(): Promise<PanTiltState> {
  if (!initialized && !initError) {
    try {
      await ensureDriver();
    } catch {
      // state.error is filled in below from initError
    }
  }
  return { ...state, available: pwm !== null, error: initError };
}

export async function movePanTilt(direction: PanTiltDirection, stepDeg = 10): Promise<PanTiltState> {
  const driver = await ensureDriver();
  let targetPan = state.pan;
  let targetTilt = state.tilt;
  if (direction === 'left') targetPan = clamp(state.pan - stepDeg, PAN_MIN, PAN_MAX);
  if (direction === 'right') targetPan = clamp(state.pan + stepDeg, PAN_MIN, PAN_MAX);
  if (direction === 'up') targetTilt = clamp(state.tilt - stepDeg, TILT_MIN, TILT_MAX);
  if (direction === 'down') targetTilt = clamp(state.tilt + stepDeg, TILT_MIN, TILT_MAX);
  return animateTo(driver, targetPan, targetTilt);
}

export async function centerPanTilt(): Promise<PanTiltState> {
  const driver = await ensureDriver();
  return animateTo(driver, CENTER_PAN, CENTER_TILT);
}

export function stopPanTilt(): void {
  if (animationTimer) clearInterval(animationTimer);
  animationTimer = null;
}
