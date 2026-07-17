// ============================================================================
// config.js — single source of truth for the "想法 → 偏旁与笔画 → 二进制" intro.
// Tuning the cinematic happens here: timing table, palette, physics, camera,
// performance tiers. Everything else reads these constants.
// ============================================================================

export const T = Object.freeze({
  // --- master timeline anchors (seconds) — matches the PROMPT pacing table ---
  SHOW_END: 1.5,        // 0.0–1.5  quiet display of 想法 + IDEA
  FALL_START: 1.5,      // 1.5      gravity switches on, chars lose support
  FALL_END: 3.8,        // 1.5–3.8  free fall, camera follows, ground rises
  APPROACH_PEAK: 4.3,   // 3.8–4.5  speed/pressure peak + visual breath-hold
  IMPACT1: 4.5,         // 4.5–5.2  first impact → chars shatter into radicals
  SHATTER_END: 5.2,
  SLOWMO_START: 5.4,    // brief slow-mo while radicals ascend
  SLOWMO_END: 6.4,
  IMPACT2_START: 6.8,   // 6.8–8.2  second fall + consecutive impacts
  IMPACT2_END: 8.2,
  SPLASH_PEAK: 8.8,     // 8.2–9.5  radicals convert to binary splash
  SETTLE_START: 9.5,    // 9.5–12.0 digits settle, sink, fade; camera pulls back
  END: 12.0,

  // physics timescale multipliers (slow-mo is a gentle dip, not a freeze)
  SLOWMO_SCALE: 0.28,
  HOLD_SCALE: 0.6,      // slight ease near the first impact (breath-hold)
});

// Slow-mo active window helper (used by physics + camera rig).
export function slowmoScaleAt(t) {
  if (t < T.SLOWMO_START || t > T.SLOWMO_END) return 1;
  // smooth in/out
  const u = (t - T.SLOWMO_START) / (T.SLOWMO_END - T.SLOWMO_START);
  const w = Math.sin(u * Math.PI); // 0→1→0
  return 1 + (T.SLOWMO_SCALE - 1) * w;
}

// Gentle breath-hold deceleration just before the first impact.
export function approachScaleAt(t) {
  if (t < T.APPROACH_PEAK - 0.25 || t > T.IMPACT1 + 0.1) return 1;
  const u = (t - (T.APPROACH_PEAK - 0.25)) / (T.IMPACT1 + 0.1 - (T.APPROACH_PEAK - 0.25));
  const w = Math.sin(u * Math.PI);
  return 1 + (T.HOLD_SCALE - 1) * w;
}

// ----------------------------------------------------------------------------
// Palette — deep black, charcoal, cool white; cold blue ONLY in binary phase.
// ----------------------------------------------------------------------------
export const COLORS = Object.freeze({
  bg:        0x050608,
  fog:       0x06080b,
  fogDensity: 0.018,
  stone:     0xeceff1, // 想/法 ceramic / frosted-stone cool white
  stoneEdge: 0xb9c0c6,
  idea:      0xd8dfe4, // IDEA — slightly dimmer, wide tracking
  ground:    0x090b0e, // just barely lifted off the background
  groundEdge:0x14181d,
  rim:       0x8a98a4, // low-angle contour light (cool white)
  key:       0xb6c2cb,
  binBlue:   0x5fcfff, // cold blue — binary phase only
  binWhite:  0xd6f0ff,
  dust:      0x6b7480,
});

// ----------------------------------------------------------------------------
// Layout & scale (world units)
// ----------------------------------------------------------------------------
export const LAYOUT = Object.freeze({
  charH:        4.0,
  charW:        4.0,
  gap:          0.55,   // 想 | 法 spacing
  startCY:      2.8,    // characters' vertical center at rest
  ideaY:        1.15,   // IDEA sits below the characters
  // 想 is heavier/bigger: starts a touch higher & left, ends lower.
  xiangOffset:  { x: -2.35, y: 0.10 },
  faOffset:     { x:  2.35, y: 0.0 },
  groundYFinal: -5.0,   // top surface of the ground plane at impact
  groundYStart: -26.0,  // ground begins far below, rises into frame
  stageHalfW:   11.0,   // spread clamp for debris / splash on the ground
});

// ----------------------------------------------------------------------------
// Physics — choreographed, gravity-driven. Per-mass weight differences give
// 想 a heavier read than 法 without a full physics engine.
// ----------------------------------------------------------------------------
export const PHYS = Object.freeze({
  gravity:      -9.4,
  fallGravity:  -11.5,  // a touch stronger during the initial drop for weight
  airDragLin:   0.018,
  airDragAng:   0.55,
  restitution:  0.30,
  friction:     0.78,
  settleSpeed:  0.35,   // below this tangential speed, a body comes to rest
  maxFallV:     -16.0,
});

// ----------------------------------------------------------------------------
// Camera rig keyframes. Position + lookAt target, interpolated by GSAP.
// Slight telephoto (low FOV) for a sculptural, compressed feel.
// ----------------------------------------------------------------------------
export const CAM = Object.freeze({
  fovDesktop: 34,
  fovMobile:  42,
  keys: [
    // {t, pos:[x,y,z], look:[x,y,z]}
    { t: T.SHOW_END,    pos: [0.0,  2.0, 17.5], look: [0.0,  1.6, 0.0] },
    { t: T.FALL_END,    pos: [0.2,  0.4, 15.0], look: [0.0,  0.0, 0.0] },
    { t: T.APPROACH_PEAK, pos: [0.5, -2.4, 12.0], look: [0.0, -3.2, 0.0] }, // low angle = weight
    { t: T.IMPACT1 + 0.05, pos: [0.4, -3.0, 11.2], look: [0.0, -4.2, 0.0] },
    { t: T.SLOWMO_END,  pos: [0.2, -2.6, 10.4], look: [0.0, -4.0, 0.0] }, // push in during slow-mo
    { t: T.SPLASH_PEAK, pos: [0.1, -2.2, 11.6], look: [0.0, -4.4, 0.0] }, // steady, let splash be hero
    { t: T.SETTLE_START, pos: [0.0, -1.4, 13.2], look: [0.0, -3.6, 0.0] },
    { t: T.END,         pos: [0.0,  1.0, 18.5], look: [0.0, -1.2, 0.0] }, // pull back, settle to quiet
  ],
  shake: { dur: 0.5, amp: 0.34, freq: 38 }, // impact1 camera shake
  shake2: { dur: 0.42, amp: 0.18, freq: 30 }, // impact2 gentler
});

// ----------------------------------------------------------------------------
// Binary splash tuning
// ----------------------------------------------------------------------------
export const SPLASH = Object.freeze({
  // per-impact digit counts are scaled by perf tier; these are HIGH-tier maxima.
  digitsPerRadicalHigh: 260,
  digitsPerRadicalMed:  150,
  digitsPerRadicalLow:  70,
  spread:     3.2,    // horizontal flight radius
  upPower:    7.4,    // initial upward splash velocity
  outPower:   5.6,
  slidePower: 3.4,
  gravity:    -12.0,
  drag:       0.6,
  sinkAt:     0.5,    // when settled, sink into ground
  life:       [3.0, 5.5], // seconds before fading
});

// ----------------------------------------------------------------------------
// Performance tiers. main.js picks one via detectTier() then may downgrade
// live if measured frame time is poor.
// ----------------------------------------------------------------------------
export const PERF_TIERS = Object.freeze({
  high: {
    bloom: true, bloomStrength: 0.62, shadows: false,
    dpr: 2, dust: 90, motionBlur: 0.0, maxBodies: 60,
    digitScale: 1.0, ripples: 3,
  },
  medium: {
    bloom: true, bloomStrength: 0.45, shadows: false,
    dpr: 1.5, dust: 50, motionBlur: 0.0, maxBodies: 44,
    digitScale: 0.85, ripples: 2,
  },
  low: {
    bloom: false, bloomStrength: 0.0, shadows: false,
    dpr: 1, dust: 24, motionBlur: 0.0, maxBodies: 30,
    digitScale: 0.7, ripples: 1,
  },
});

// Quality labels for the (tiny) debug overlay; harmless to keep.
export const META = Object.freeze({
  title: '想法',
  subtitle: 'IDEA',
  version: '1.0.0',
});
