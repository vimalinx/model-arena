// ============================================================================
// util.js — math, RNG, easing, device/perf detection. No dependencies.
// ============================================================================

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const mapRange = (v, a, b, c, d) => c + ((v - a) * (d - c)) / (b - a);
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const smootherstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

// Frame-rate independent exponential approach (a la unity's Mathf.SmoothDamp).
// lambda ~ "stiffness" per second. dt in seconds.
export const damp = (a, b, lambda, dt) =>
  lerp(a, b, 1 - Math.exp(-lambda * dt));

// --- seeded RNG so debris spreads look "art-directed" but are reproducible ---
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RNG {
  constructor(seed = 1) { this.s = seed >>> 0; this.n = mulberry32(this.s); }
  reset(seed = 1) { this.s = seed >>> 0; this.n = mulberry32(this.s); }
  next() { return this.n(); }
  range(a, b) { return a + (b - a) * this.n(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  sign() { return this.n() < 0.5 ? -1 : 1; }
  pick(arr) { return arr[Math.floor(this.n() * arr.length)]; }
  // gaussian-ish via sum of uniforms
  gauss(mean = 0, dev = 1) {
    const u = (this.n() + this.n() + this.n() + this.n()) / 4 - 0.5;
    return mean + u * dev * 2.0;
  }
}

// --- easings (used by physics-derived tweens; GSAP covers the timeline) ---
export const ease = {
  inCubic:  t => t * t * t,
  outCubic: t => 1 - Math.pow(1 - t, 3),
  inOutCubic: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuint: t => 1 - Math.pow(1 - t, 5),
  inOutQuart: t => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
  outBack: (t, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
};

// ----------------------------------------------------------------------------
// Device + performance detection → tier key into PERF_TIERS.
// ----------------------------------------------------------------------------
export function isMobile() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const touch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  const uaMobile = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua);
  const small = window.innerWidth < 820;
  return uaMobile || (touch && small);
}

export function detectTier() {
  if (isMobile()) {
    // even capable phones get medium at most
    const cores = navigator.hardwareConcurrency || 4;
    return cores >= 8 ? 'medium' : 'low';
  }
  const cores = navigator.hardwareConcurrency || 4;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const mem = navigator.deviceMemory || 4; // chrome-only hint
  if (cores >= 8 && mem >= 8 && dpr >= 1.5) return 'high';
  if (cores >= 4) return 'medium';
  return 'low';
}

// Quick live probe: call once after a warm-up frame; if avg frame time is bad,
// main.js downgrades the tier.
export function measureFrameQuality(avgFrameMs) {
  if (avgFrameMs > 26) return -1; // struggling → step down
  if (avgFrameMs > 18) return 0;
  return 1; // headroom
}
