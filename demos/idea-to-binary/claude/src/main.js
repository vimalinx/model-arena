// ============================================================================
// main.js — engine for "想法 → 偏旁与笔画 → 二进制".
//
// Pipeline:
//   init()  → renderer / scene / camera / lights / ground / dust / audio (once)
//   loadFont() → opentype CJK → extruded 3D glyphs (with hole detection)
//                | fail → canvas-slab fallback (no tofu)
//   buildPayload() → 想法 whole group + radical/stroke fragments + IDEA label
//   buildTimeline() → GSAP master timeline (fall → impact1 → slow-mo → impact2
//                     → binary splash → settle)
//   animate() → camera rig + shake, physics bodies, binary field, ripples,
//               sweep, dust, render
//
// All tuning lives in ./config.js (T, COLORS, LAYOUT, PHYS, CAM, SPLASH, tiers).
// Math/RNG/device helpers live in ./util.js.
// ============================================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import {
  T, COLORS, LAYOUT, PHYS, CAM, SPLASH, PERF_TIERS, META,
  slowmoScaleAt, approachScaleAt,
} from './config.js';
import {
  TAU, clamp, lerp, smoothstep, smootherstep, damp, RNG, ease,
  isMobile, detectTier, measureFrameQuality,
} from './util.js';

const gsap = window.gsap;
const opentype = (window.opentype && (window.opentype.default || window.opentype)) || window.opentype;

// ----------------------------------------------------------------------------
// Global state
// ----------------------------------------------------------------------------
let renderer, scene, camera, composer, bloomPass;
let clock;

let tierKey = 'medium';
let tier = PERF_TIERS[tierKey];
let mobile = false;

let masterTime = 0;     // seconds, driven by the GSAP timeline
let timeScale = 1;      // slow-mo / breath-hold multiplier for physics
let playing = false;
let fontReady = false;
let buildMode = 'opentype'; // 'opentype' | 'canvas'
let font = null;

// fps-based live downgrade
let fpsAccum = 0, fpsFrames = 0, fpsTimer = 0, probedTier = false;

// persistent scene objects
let ground, groundMat, dust, dustBase;
let keyLight, rimLight, fillLight, blueLight;
let sweepMesh;

// payload (rebuilt on each play / replay)
let payload = null;

// effects
let binField, ripples;

// audio
let audio = null;

// timeline
let tl = null;

// camera rig helpers
const camLookAt = new THREE.Vector3();
let shake = { active: false, t: 0, dur: 0, amp: 0, freq: 0 };

// RNG (seeded → reproducible art direction)
const rng = new RNG(0xC0FFEE);

// Reusable scratch
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m4 = new THREE.Matrix4();

const GROUND_Y = LAYOUT.groundYFinal; // top surface of the ground plane

// ============================================================================
// DOM
// ============================================================================
const dom = {};
function cacheDom() {
  dom.app = document.getElementById('app');
  dom.loader = document.getElementById('loader');
  dom.replay = document.getElementById('replay');
  dom.sound = document.getElementById('sound-hint');
  dom.fallback = document.getElementById('webgl-fallback');
}

// ============================================================================
// INIT
// ============================================================================
async function init() {
  cacheDom();
  mobile = isMobile();
  tierKey = detectTier();
  tier = PERF_TIERS[tierKey];

  if (dom.sound) {
    dom.sound.addEventListener('click', () => {
      if (audio) audio.toggle();
    });
  }
  if (dom.replay) {
    dom.replay.addEventListener('click', () => { ensureAudioGesture(); replay(); });
  }
  // Browsers block audio until a gesture — grab one anywhere.
  const gesture = () => ensureAudioGesture();
  window.addEventListener('pointerdown', gesture, { once: false });
  window.addEventListener('keydown', gesture, { once: false });

  try {
    setupRenderer();
    setupScene();
    setupCamera();
    setupLights();
    setupEnvironment();
    setupGround();
    setupDust();
    setupSweep();
    setupComposer();
  } catch (err) {
    console.error('WebGL init failed', err);
    if (dom.fallback) dom.fallback.hidden = false;
    if (dom.loader) dom.loader.style.display = 'none';
    return;
  }

  binField = new BinaryField(scene, tierKey);
  ripples = new RippleField(scene, tier.ripples);

  audio = new AudioEngine();
  window.addEventListener('resize', onResize);
  onResize();

  clock = new THREE.Clock();
  animate();

  await loadFont();
  fontReady = true;

  startPlay();

  // live perf probe
  schedulePerfProbe();
}

function setupRenderer() {
  renderer = new THREE.WebGLRenderer({
    antialias: tier.dpr > 1.25,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.dpr));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  dom.app.appendChild(renderer.domElement);
}

function setupScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.bg);
  scene.fog = new THREE.FogExp2(COLORS.fog, COLORS.fogDensity);
}

function setupCamera() {
  const fov = mobile ? CAM.fovMobile : CAM.fovDesktop;
  camera = new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, 0.1, 220);
  const k0 = CAM.keys[0];
  camera.position.set(k0.pos[0], k0.pos[1], k0.pos[2]);
  camLookAt.set(k0.look[0], k0.look[1], k0.look[2]);
  camera.lookAt(camLookAt);
}

function setupLights() {
  fillLight = new THREE.HemisphereLight(0x2a333d, 0x05060a, 0.55);
  scene.add(fillLight);

  keyLight = new THREE.DirectionalLight(COLORS.key, 1.15);
  keyLight.position.set(5.5, 12.0, 9.0);
  scene.add(keyLight);

  // low-angle contour light — grazes the ground & separates it from the void
  rimLight = new THREE.DirectionalLight(COLORS.rim, 0.55);
  rimLight.position.set(-9.0, 1.6, -6.0);
  scene.add(rimLight);

  // cool blue accent, only lights up during the binary phase
  blueLight = new THREE.PointLight(COLORS.binBlue, 0.0, 26, 2.0);
  blueLight.position.set(0, GROUND_Y + 1.6, 3.0);
  scene.add(blueLight);
}

function setupEnvironment() {
  // soft ceramic reflections on the sculpted glyphs
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new RoomEnvironment();
    const envRT = pmrem.fromScene(envScene, 0.04);
    scene.environment = envRT.texture;
    pmrem.dispose();
  } catch (e) { /* environment is cosmetic */ }
}

function setupGround() {
  const geo = new THREE.PlaneGeometry(80, 80, 1, 1);
  groundMat = new THREE.MeshStandardMaterial({
    color: COLORS.ground,
    roughness: 0.72,
    metalness: 0.0,
    envMapIntensity: 0.35,
  });
  ground = new THREE.Mesh(geo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = LAYOUT.groundYStart; // starts far below, rises into frame on the fall
  ground.position.z = -4;
  scene.add(ground);

  // a barely-there darker disc to suggest a stage edge / reflection falloff
  const discGeo = new THREE.CircleGeometry(14, 64);
  const discMat = new THREE.MeshBasicMaterial({
    color: 0x04050a, transparent: true, opacity: 0.0, depthWrite: false,
  });
  const disc = new THREE.Mesh(discGeo, discMat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.set(0, GROUND_Y + 0.01, -4);
  scene.add(disc);
}

// --- dust: faint drifting motes in the volume ---
function setupDust() {
  const count = tier.dust;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3 + 0] = rng.range(-14, 14);
    positions[i * 3 + 1] = rng.range(GROUND_Y - 1, 12);
    positions[i * 3 + 2] = rng.range(-12, 8);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: COLORS.dust,
    size: 0.045,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    map: makeSoftDotTexture(),
    blending: THREE.NormalBlending,
  });
  dust = new THREE.Points(geo, mat);
  dustBase = dust.geometry.attributes.position.array.slice(0);
  scene.add(dust);
}

function setupSweep() {
  // final thin light that grazes the ground near the end
  const geo = new THREE.PlaneGeometry(9.0, 0.07);
  const mat = new THREE.MeshBasicMaterial({
    color: COLORS.binBlue, transparent: true, opacity: 0.0,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  sweepMesh = new THREE.Mesh(geo, mat);
  sweepMesh.rotation.x = -Math.PI / 2;
  sweepMesh.position.set(-7, GROUND_Y + 0.02, -3.5);
  sweepMesh.visible = false;
  scene.add(sweepMesh);
}

// ============================================================================
// TEXTURES
// ============================================================================
function makeSoftDotTexture() {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeDigitAtlas() {
  const cell = 128;
  const c = document.createElement('canvas');
  c.width = cell * 2; c.height = cell;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `800 ${cell * 0.82}px "JetBrains Mono", "SF Mono", "Consolas", monospace`;
  g.fillText('0', cell * 0.5, cell * 0.54);
  g.fillText('1', cell * 1.5, cell * 0.54);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// ============================================================================
// FONT LOADING + GLYPH GEOMETRY
// ============================================================================
const FONT_URLS = [
  'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Bold.otf',
  'https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Bold.otf',
  'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf',
];

async function loadFont() {
  if (!opentype) { console.warn('opentype.js unavailable — using canvas fallback'); return; }
  for (const url of FONT_URLS) {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      const f = opentype.parse(buf);
      // sanity check: the glyph must exist & have outline
      const g = f.charToGlyph('想');
      if (g && g.path && g.path.commands && g.path.commands.length > 4) {
        font = f;
        buildMode = 'opentype';
        console.log('font loaded:', url);
        return;
      }
    } catch (e) {
      console.warn('font fetch failed:', url, e);
    }
  }
  console.warn('All CJK font sources failed — using canvas fallback');
  buildMode = 'canvas';
}

// --- opentype path → THREE.Shape[] with even-odd hole nesting ---
function pathToContours(commands) {
  const contours = [];
  let cur = null;
  for (const c of commands) {
    if (c.type === 'M') { cur = []; contours.push(cur); }
    if (!cur) { cur = []; contours.push(cur); }
    cur.push(c);
  }
  return contours.filter(c => c.length > 1);
}

function contourToPolyline(cmds, subdiv = 10) {
  const pts = [];
  let cx = 0, cy = 0;
  for (const c of cmds) {
    if (c.type === 'M') { cx = c.x; cy = c.y; pts.push({ x: cx, y: cy }); }
    else if (c.type === 'L') { cx = c.x; cy = c.y; pts.push({ x: cx, y: cy }); }
    else if (c.type === 'Q') {
      for (let i = 1; i <= subdiv; i++) {
        const t = i / subdiv, u = 1 - t;
        pts.push({
          x: u * u * cx + 2 * u * t * c.x1 + t * t * c.x,
          y: u * u * cy + 2 * u * t * c.y1 + t * t * c.y,
        });
      }
      cx = c.x; cy = c.y;
    } else if (c.type === 'C') {
      for (let i = 1; i <= subdiv; i++) {
        const t = i / subdiv, u = 1 - t;
        pts.push({
          x: u * u * u * cx + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
          y: u * u * u * cy + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
        });
      }
      cx = c.x; cy = c.y;
    } else if (c.type === 'Z') {
      if (pts.length) pts.push({ x: pts[0].x, y: pts[0].y });
    }
  }
  return pts;
}

function polyArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return a / 2;
}

function pointInPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y)) &&
      (p.x < ((xj - xi) * (p.y - yi)) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function contourToShape(cmds) {
  const s = new THREE.Shape();
  for (const c of cmds) {
    switch (c.type) {
      case 'M': s.moveTo(c.x, c.y); break;
      case 'L': s.lineTo(c.x, c.y); break;
      case 'Q': s.quadraticCurveTo(c.x1, c.y1, c.x, c.y); break;
      case 'C': s.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y); break;
      case 'Z': s.closePath(); break;
    }
  }
  return s;
}

function buildShapes(char, emSize) {
  const glyph = font.charToGlyph(char);
  const path = glyph.getPath(0, 0, emSize); // world-space coords, Y-up
  const contours = pathToContours(path.commands);
  if (!contours.length) return [];

  const items = contours.map(cmds => {
    const pts = contourToPolyline(cmds);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    }
    return { cmds, pts, area: polyArea(pts), minX, minY, maxX, maxY, parent: -1, depth: 0 };
  });

  // parent = innermost (smallest-area) contour that contains this one
  for (let i = 0; i < items.length; i++) {
    const seed = items[i].pts[0];
    if (!seed) continue;
    let best = -1, bestArea = Infinity;
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      if (pointInPoly(seed, items[j].pts)) {
        const a = Math.abs(items[j].area);
        if (a < bestArea) { bestArea = a; best = j; }
      }
    }
    items[i].parent = best;
  }
  for (const it of items) {
    let p = it.parent, g = 0;
    while (p !== -1 && g++ < 64) { it.depth++; p = items[p].parent; }
  }

  const shapes = [];
  const shapeMap = {};
  for (let i = 0; i < items.length; i++) {
    if (items[i].depth % 2 === 0) {
      const s = contourToShape(items[i].cmds);
      shapeMap[i] = s; shapes.push(s);
    }
  }
  for (let i = 0; i < items.length; i++) {
    if (items[i].depth % 2 === 1) {
      let p = items[i].parent, g = 0;
      while (p !== -1 && items[p].depth % 2 !== 0 && g++ < 64) p = items[p].parent;
      if (p !== -1 && shapeMap[p]) shapeMap[p].holes.push(contourToShape(items[i].cmds));
    }
  }
  return shapes;
}

// Build one extruded, centered glyph mesh.
function buildExtrudedGlyph(char, {
  emSize = 4.0, depth = 0.5, bevel = 0.07, bevelSegs = 2, curveSegs = 14,
  targetHeight = null, material = null,
} = {}) {
  const shapes = buildShapes(char, emSize);
  if (!shapes.length) return null;
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.9,
    bevelOffset: 0,
    bevelSegments: bevelSegs,
    curveSegments: curveSegs,
    steps: 1,
  });
  geo.computeVertexNormals();
  geo.center();
  if (targetHeight) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const h = (bb.max.y - bb.min.y) || 1;
    const s = targetHeight / h;
    geo.scale(s, s, s);
  }
  const mat = material || stoneMaterial();
  return new THREE.Mesh(geo, mat);
}

// canvas fallback: beveled slab with the glyph as alpha texture
function buildCanvasGlyph(char, { targetHeight = 4.0, depth = 0.5 } = {}) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `700 ${Math.floor(size * 0.74)}px "Noto Sans SC","Noto Sans CJK SC","Source Han Sans SC","Microsoft YaHei","PingFang SC",sans-serif`;
  g.fillText(char, size / 2, size / 2 + size * 0.03);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;

  const geo = new THREE.BoxGeometry(targetHeight * 0.92, targetHeight * 0.92, depth, 1, 1, 1);
  // bevel-ish: skip; keep simple slab
  const mat = new THREE.MeshStandardMaterial({
    color: COLORS.stone,
    map: tex,
    alphaMap: tex,
    transparent: true,
    roughness: 0.6,
    metalness: 0.05,
    side: THREE.DoubleSide,
    envMapIntensity: 0.8,
  });
  return new THREE.Mesh(geo, mat);
}

function buildGlyph(char, opts) {
  if (buildMode === 'opentype' && font) {
    const m = buildExtrudedGlyph(char, opts);
    if (m) return m;
  }
  return buildCanvasGlyph(char, { targetHeight: opts.targetHeight || opts.emSize || 4.0, depth: opts.depth || 0.4 });
}

// ============================================================================
// MATERIALS
// ============================================================================
function stoneMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: COLORS.stone,
    roughness: 0.58,
    metalness: 0.04,
    clearcoat: 0.35,
    clearcoatRoughness: 0.55,
    envMapIntensity: 0.95,
    side: THREE.DoubleSide,
  });
}
function fragmentMaterial() {
  return new THREE.MeshStandardMaterial({
    color: COLORS.stoneEdge,
    roughness: 0.62,
    metalness: 0.06,
    envMapIntensity: 0.9,
    side: THREE.DoubleSide,
  });
}
function ideaMaterial() {
  return new THREE.MeshStandardMaterial({
    color: COLORS.idea,
    roughness: 0.5,
    metalness: 0.1,
    transparent: true,
    opacity: 0.78,
    envMapIntensity: 0.7,
    side: THREE.DoubleSide,
  });
}

// ============================================================================
// PAYLOAD (想法 + radicals + strokes + IDEA) — rebuilt each play
// ============================================================================
function buildPayload() {
  const p = {
    group: new THREE.Group(),
    whole: { xiang: null, fa: null },
    ideaLetters: [],
    ideaGroup: new THREE.Group(),
    radicalTemplates: {},   // char -> Mesh template
    strokeTemplates: [],    // Mesh[] templates
    bodies: [],             // active physics bodies (filled at impact)
    allMeshes: [],          // every cloned body mesh (for clean disposal on replay)
    converted: false,
  };

  const charH = LAYOUT.charH;
  const depth = 0.62;
  const bevel = 0.08;

  // whole characters (sculpted)
  const xiang = buildGlyph('想', { emSize: charH, depth, bevel, targetHeight: charH, material: stoneMaterial() });
  const fa = buildGlyph('法', { emSize: charH, depth, bevel, targetHeight: charH, material: stoneMaterial() });

  p.whole.xiang = xiang;
  p.whole.fa = fa;

  // rest positions
  const xRest = LAYOUT.startCY + LAYOUT.xiangOffset.y;
  const fRest = LAYOUT.startCY + LAYOUT.faOffset.y;
  xiang.position.set(LAYOUT.xiangOffset.x, xRest, 0);
  fa.position.set(LAYOUT.faOffset.x, fRest, 0);
  p.group.add(xiang, fa);

  // radical templates (smaller, recognisable fragments)
  const fragH = charH * 0.5;
  const fragDepth = 0.42;
  const fragBevel = 0.06;
  const radicalDefs = [
    { char: '木', size: fragH * 1.05 },
    { char: '目', size: fragH * 0.95 },
    { char: '心', size: fragH * 0.9 },
    { char: '氵', size: fragH * 0.8 },
    { char: '去', size: fragH * 1.0 },
  ];
  const fmat = fragmentMaterial();
  for (const d of radicalDefs) {
    const m = buildGlyph(d.char, { emSize: d.size, depth: fragDepth, bevel: fragBevel, targetHeight: d.size, material: fmat });
    p.radicalTemplates[d.char] = m;
    m.visible = false;
  }

  // stroke fragments — thin slabs (broken strokes / 笔画)
  const sMat = fragmentMaterial();
  for (let i = 0; i < 6; i++) {
    const w = rng.range(0.28, 0.7);
    const h = rng.range(0.9, 1.7);
    const dpt = rng.range(0.16, 0.3);
    const geo = new THREE.BoxGeometry(w, h, dpt);
    const m = new THREE.Mesh(geo, sMat);
    m.visible = false;
    p.strokeTemplates.push(m);
  }

  // IDEA — 4 letters, wide tracking, sits just under the characters
  const ideaChars = ['I', 'D', 'E', 'A'];
  const iMat = ideaMaterial();
  const ideaH = 0.62;
  const tracking = 0.78;
  const ideaStartX = -((ideaChars.length - 1) * tracking) / 2;
  const ideaY = LAYOUT.startCY - charH * 0.5 - 0.85;
  for (let i = 0; i < ideaChars.length; i++) {
    const m = buildGlyph(ideaChars[i], { emSize: ideaH, depth: 0.12, bevel: 0.02, targetHeight: ideaH, material: iMat });
    m.position.set(ideaStartX + i * tracking, ideaY, 0);
    p.ideaLetters.push(m);
    p.ideaGroup.add(m);
  }

  p.group.add(p.ideaGroup);
  scene.add(p.group);

  payload = p;
  return p;
}

function disposePayload() {
  if (!payload) return;
  // kill & remove every cloned body mesh (some may still be mid-shrink tween)
  payload.allMeshes.forEach(m => {
    if (m) { gsap.killTweensOf(m.scale); if (m.parent) m.parent.remove(m); }
  });
  // radical / stroke templates share one geometry each — dispose geometries once,
  // and their shared materials once (bodies reuse these, they're already detached)
  const deadMats = new Set();
  Object.values(payload.radicalTemplates).forEach(m => {
    if (m.geometry) m.geometry.dispose();
    if (m.material) deadMats.add(m.material);
  });
  payload.strokeTemplates.forEach(m => {
    if (m.geometry) m.geometry.dispose();
    if (m.material) deadMats.add(m.material);
  });
  // whole chars + IDEA live in the group
  payload.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) deadMats.add(o.material); });
  deadMats.forEach(m => m.dispose());
  if (payload.group.parent) payload.group.parent.remove(payload.group);
  payload = null;
}

// ============================================================================
// PHYSICS BODY
// ============================================================================
function makeBody(template, opts) {
  // clone mesh so each fragment is independent (share geometry + material)
  const mesh = new THREE.Mesh(template.geometry, template.material);
  mesh.visible = true;
  mesh.position.copy(opts.pos);
  mesh.rotation.set(opts.rot?.x || 0, opts.rot?.y || 0, opts.rot?.z || 0);
  scene.add(mesh);

  // estimate half-height from bounding box for ground contact
  template.geometry.computeBoundingBox();
  const bb = template.geometry.boundingBox;
  const halfH = Math.max(0.15, (bb.max.y - bb.min.y) * 0.5 * (opts.scale || 1));
  mesh.scale.setScalar(opts.scale || 1);

  return {
    mesh,
    kind: opts.kind,
    pos: opts.pos.clone(),
    vel: opts.vel.clone(),
    angVel: opts.angVel.clone(),
    size: opts.size,
    halfH,
    mass: opts.mass,
    restitution: opts.restitution ?? PHYS.restitution,
    state: 'flying',     // flying -> converted
    convertDigits: opts.convertDigits,
    born: masterTime,
  };
}

function updateBodies(dt) {
  if (!payload) return;
  const g = PHYS.gravity;
  const drag = PHYS.airDragLin;
  const angDrag = PHYS.airDragAng;
  const list = payload.bodies;
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    if (b.state !== 'flying') continue;

    // integrate (semi-implicit Euler)
    b.vel.y += g * dt;
    b.vel.multiplyScalar(Math.max(0, 1 - drag * dt));
    b.pos.addScaledVector(b.vel, dt);

    // angular
    b.angVel.multiplyScalar(Math.max(0, 1 - angDrag * dt));
    b.mesh.rotation.x += b.angVel.x * dt;
    b.mesh.rotation.y += b.angVel.y * dt;
    b.mesh.rotation.z += b.angVel.z * dt;

    b.mesh.position.copy(b.pos);

    // descending ground contact -> convert to binary (second impact)
    const floor = GROUND_Y + b.halfH;
    if (b.pos.y <= floor && b.vel.y < 0) {
      convertBody(b);
    }
  }
}

function convertBody(b) {
  b.state = 'converted';
  // burst of binary digits where the radical lands
  const count = Math.round(b.convertDigits);
  binField.spawn(b.pos.clone(), count, {
    spread: SPLASH.spread,
    upPower: SPLASH.upPower * (0.85 + rng.next() * 0.4),
    outPower: SPLASH.outPower,
    slidePower: SPLASH.slidePower,
    life: SPLASH.life,
  });
  // faint blue ripple
  ripples.trigger(_v1.set(b.pos.x, GROUND_Y + 0.02, b.pos.z), { color: COLORS.binBlue, max: 3.4, opacity: 0.22, dur: 0.9 });
  // audio: small splash + digital tick
  if (audio) audio.convert(b.size);
  // the radical is absorbed — shrink & hide
  gsap.to(b.mesh.scale, { x: 0.01, y: 0.01, z: 0.01, duration: 0.32, ease: 'power2.in', onComplete: () => {
    if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
  } });
  // remove from active list
  const idx = payload.bodies.indexOf(b);
  if (idx >= 0) payload.bodies.splice(idx, 1);
}

// ============================================================================
// BINARY FIELD — instanced 0/1 splash
// ============================================================================
class BinaryField {
  constructor(scene, tierKey) {
    this.scene = scene;
    this.pool = tierKey === 'high' ? 2600 : tierKey === 'medium' ? 1500 : 700;
    this.dpi = tierKey === 'high' ? SPLASH.digitsPerRadicalHigh
      : tierKey === 'medium' ? SPLASH.digitsPerRadicalMed : SPLASH.digitsPerRadicalLow;

    const geo = new THREE.PlaneGeometry(0.16, 0.22);
    this.geo = geo;
    geo.setAttribute('aType', new THREE.InstancedBufferAttribute(new Float32Array(this.pool), 1));
    geo.setAttribute('aBorn', new THREE.InstancedBufferAttribute(new Float32Array(this.pool), 1));
    geo.setAttribute('aDie', new THREE.InstancedBufferAttribute(new Float32Array(this.pool), 1));

    this.atlas = makeDigitAtlas();
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAtlas: { value: this.atlas },
        uBlue: { value: new THREE.Color(COLORS.binBlue) },
        uWhite: { value: new THREE.Color(COLORS.binWhite) },
      },
      vertexShader: /* glsl */ `
        attribute float aType;
        attribute float aBorn;
        attribute float aDie;
        varying float vType;
        varying vec2 vUv;
        varying float vAlpha;
        uniform float uTime;
        void main() {
          vType = aType;
          vec2 auv = uv;
          auv.x = uv.x * 0.5 + aType * 0.5;
          vUv = auv;
          float la = smoothstep(aBorn, aBorn + 0.12, uTime)
                   * (1.0 - smoothstep(aDie - 0.8, aDie, uTime));
          vAlpha = la;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uAtlas;
        uniform vec3 uBlue;
        uniform vec3 uWhite;
        uniform float uTime;
        varying float vType;
        varying vec2 vUv;
        varying float vAlpha;
        void main() {
          float a = texture2D(uAtlas, vUv).a;
          if (a < 0.04) discard;
          vec3 col = mix(uWhite, uBlue, 0.42);
          float flick = 1.25 + 0.45 * sin(uTime * 7.0 + vType * 5.0 + vUv.y * 40.0);
          col *= clamp(flick, 0.8, 2.1);
          gl_FragColor = vec4(col, a * clamp(vAlpha, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });

    this.mesh = new THREE.InstancedMesh(geo, this.mat, this.pool);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;

    // per-slot sim state
    this.slots = [];
    for (let i = 0; i < this.pool; i++) {
      this.slots.push({
        active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        rot: 0, rotV: 0, tilt: new THREE.Euler(),
        sx: 1, sy: 1, type: 0, born: -99, die: -98, phase: 0, sink: 0,
      });
      geo.attributes.aType.array[i] = 0;
      geo.attributes.aBorn.array[i] = -99;
      geo.attributes.aDie.array[i] = -98;
      _m4.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, _m4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    geo.attributes.aType.needsUpdate = true;
    geo.attributes.aBorn.needsUpdate = true;
    geo.attributes.aDie.needsUpdate = true;
    scene.add(this.mesh);
  }

  spawn(origin, count, opts) {
    const now = masterTime;
    const halfH = 0.11;
    let spawned = 0;
    for (let i = 0; i < this.pool && spawned < count; i++) {
      const s = this.slots[i];
      if (s.active) continue;

      // distribute roles: splash / skimmer / droplet
      const r = rng.next();
      let phase;
      if (r < 0.55) phase = 0;       // arc up then land + slide
      else if (r < 0.82) phase = 1;  // fast skimmer, low arc, slides far
      else phase = 2;                // tiny droplet, short life

      const angle = rng.range(-Math.PI, Math.PI);
      const up = phase === 0 ? opts.upPower * rng.range(0.5, 1.0)
                : phase === 1 ? opts.upPower * rng.range(0.12, 0.32)
                : opts.upPower * rng.range(0.25, 0.5);
      const out = (phase === 1 ? opts.slidePower * rng.range(0.9, 1.5) : opts.outPower * rng.range(0.4, 1.0))
                * rng.range(0.5, 1.0);
      const rad = Math.max(0.05, out); // avoid degenerate

      s.active = true;
      s.phase = phase;
      s.pos.set(
        origin.x + Math.cos(angle) * rad * rng.range(0.1, 0.5),
        origin.y + rng.range(0.0, 0.4),
        origin.z + Math.sin(angle) * rad * 0.5
      );
      s.vel.set(
        Math.cos(angle) * rad,
        up,
        Math.sin(angle) * rad * 0.5
      );
      s.rot = rng.range(0, TAU);
      s.rotV = rng.range(-9, 9);
      s.tilt.set(rng.range(-0.5, 0.5), rng.range(-0.5, 0.5), rng.range(-0.5, 0.5));
      const sc = phase === 2 ? rng.range(0.35, 0.6) : rng.range(0.7, 1.3);
      s.sx = 0.16 * sc; s.sy = 0.22 * sc;
      s.type = rng.next() < 0.5 ? 0 : 1;
      s.sink = 0;
      const life = phase === 2 ? rng.range(0.6, 1.4) : rng.range(opts.life[0], opts.life[1]);
      s.born = now; s.die = now + life;

      this.geo.attributes.aType.array[i] = s.type;
      this.geo.attributes.aBorn.array[i] = s.born;
      this.geo.attributes.aDie.array[i] = s.die;
      spawned++;
    }
    this.geo.attributes.aType.needsUpdate = true;
    this.geo.attributes.aBorn.needsUpdate = true;
    this.geo.attributes.aDie.needsUpdate = true;
  }

  reset() {
    for (let i = 0; i < this.pool; i++) {
      const s = this.slots[i];
      s.active = false; s.born = -99; s.die = -98;
      this.geo.attributes.aBorn.array[i] = -99;
      this.geo.attributes.aDie.array[i] = -98;
      _m4.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, _m4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.geo.attributes.aBorn.needsUpdate = true;
    this.geo.attributes.aDie.needsUpdate = true;
  }

  update(dt, realDt, now) {
    this.mat.uniforms.uTime.value = now;
    const g = SPLASH.gravity;
    const drag = SPLASH.drag;
    const floor = GROUND_Y + 0.11;

    for (let i = 0; i < this.pool; i++) {
      const s = this.slots[i];
      if (!s.active) continue;
      if (now < s.born) continue;
      if (now > s.die) { s.active = false; _m4.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, _m4); continue; }

      // integrate
      s.vel.y += g * dt;
      s.vel.multiplyScalar(Math.max(0, 1 - drag * dt));
      s.pos.addScaledVector(s.vel, dt);
      s.rot += s.rotV * dt;

      // ground interaction — liquid feel: mostly slide / sink, few small bounces
      if (s.pos.y <= floor) {
        if (s.phase === 0 && s.vel.y < -1.0 && rng.next() < 0.35) {
          // small bounce
          s.vel.y = -s.vel.y * 0.28;
          s.vel.x *= 0.55; s.vel.z *= 0.55;
          s.pos.y = floor;
          s.phase = 1; // becomes a skimmer after bouncing
        } else {
          // land: stick to surface, become a slider, eventually sink
          s.vel.y = 0;
          s.pos.y = floor - s.sink;
          s.vel.x *= 0.82; s.vel.z *= 0.82;
          s.sink += 0.06 * dt; // gradually absorbed by the black ground
          if (Math.abs(s.vel.x) + Math.abs(s.vel.z) < 0.2) {
            s.sink += 0.5 * dt; // settled ones sink faster
          }
        }
      }

      if (s.pos.y < GROUND_Y - 0.6) { s.active = false; _m4.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, _m4); continue; }

      // clamp horizontal spread to stage
      const lim = LAYOUT.stageHalfW;
      if (s.pos.x > lim) { s.pos.x = lim; s.vel.x *= -0.3; }
      if (s.pos.x < -lim) { s.pos.x = -lim; s.vel.x *= -0.3; }

      _e.set(s.tilt.x, s.rot, s.tilt.z);
      _q.setFromEuler(_e);
      const lifeFade = 1.0; // alpha handled in shader
      _v1.set(s.sx * lifeFade, s.sy * lifeFade, 1);
      _m4.compose(s.pos, _q, _v1);
      this.mesh.setMatrixAt(i, _m4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ============================================================================
// RIPPLE FIELD — ground impact rings
// ============================================================================
class RippleField {
  constructor(scene, count) {
    this.pool = Math.max(1, count);
    this.items = [];
    const geo = new THREE.RingGeometry(0.86, 1.0, 48);
    for (let i = 0; i < this.pool; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.0,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      scene.add(m);
      this.items.push({ mesh: m, t: 0, dur: 0.9, max: 5, startOp: 0.4, active: false });
    }
  }
  trigger(pos, { color = 0xffffff, max = 5, opacity = 0.4, dur = 0.9 } = {}) {
    const free = this.items.find(it => !it.active) || this.items[0];
    free.active = true; free.t = 0; free.dur = dur; free.max = max; free.startOp = opacity;
    free.mesh.visible = true;
    free.mesh.position.set(pos.x, GROUND_Y + 0.03, pos.z);
    free.mesh.scale.setScalar(0.2);
    free.mesh.material.color.setHex(color);
    free.mesh.material.opacity = opacity;
  }
  update(realDt) {
    for (const it of this.items) {
      if (!it.active) continue;
      it.t += realDt;
      const u = clamp(it.t / it.dur, 0, 1);
      it.mesh.scale.setScalar(lerp(0.2, it.max, ease.outQuint(u)));
      it.mesh.material.opacity = it.startOp * (1 - u);
      if (u >= 1) { it.active = false; it.mesh.visible = false; }
    }
  }
  reset() { for (const it of this.items) { it.active = false; it.mesh.visible = false; } }
}

// ============================================================================
// IMPACT EVENTS
// ============================================================================
function impactXiang() {
  if (!payload) return;
  const p = payload;
  p.whole.xiang.visible = false;
  const cx = LAYOUT.xiangOffset.x;
  const cy = GROUND_Y + 0.6;
  // radicals of 想: 木 目 心
  spawnRadical('木', cx - 0.7, cy + 0.2, { spread: 0.9, up: rng.range(8.5, 11.5), size: 1.3, mass: 1.6, digitsBoost: 1.15 });
  spawnRadical('目', cx + 0.7, cy + 0.1, { spread: 0.9, up: rng.range(7.5, 10), size: 1.1, mass: 1.2, digitsBoost: 1.0 });
  spawnRadical('心', cx + 0.1, cy - 0.1, { spread: 1.1, up: rng.range(6.5, 9), size: 1.0, mass: 0.9, digitsBoost: 0.9 });
  // stroke fragments
  for (let i = 0; i < 4; i++) {
    spawnStroke(cx + rng.range(-1.2, 1.2), cy + rng.range(-0.2, 0.5), rng.range(5, 8));
  }
  triggerShake(CAM.shake);
  ripples.trigger(_v1.set(cx, GROUND_Y + 0.02, 0), { color: 0xdfe7ec, max: 5.5, opacity: 0.4, dur: 0.95 });
  stirDust(cx);
  if (audio) audio.impact(1.0);
}

function impactFa() {
  if (!payload) return;
  const p = payload;
  p.whole.fa.visible = false;
  const cx = LAYOUT.faOffset.x;
  const cy = GROUND_Y + 0.5;
  spawnRadical('氵', cx - 0.6, cy + 0.1, { spread: 0.8, up: rng.range(6.5, 9), size: 0.9, mass: 0.8, digitsBoost: 0.85 });
  spawnRadical('去', cx + 0.4, cy + 0.2, { spread: 0.9, up: rng.range(8, 10.5), size: 1.15, mass: 1.2, digitsBoost: 1.05 });
  for (let i = 0; i < 3; i++) {
    spawnStroke(cx + rng.range(-1.0, 1.0), cy + rng.range(-0.2, 0.4), rng.range(4.5, 7.5));
  }
  triggerShake(CAM.shake2);
  ripples.trigger(_v1.set(cx, GROUND_Y + 0.02, 0), { color: 0xdfe7ec, max: 4.5, opacity: 0.34, dur: 0.85 });
  stirDust(cx);
  if (audio) audio.impact(0.7);
}

function spawnRadical(char, x, y, opts) {
  const tpl = payload.radicalTemplates[char];
  if (!tpl) return;
  const angle = rng.range(-Math.PI, Math.PI);
  const out = rng.range(1.5, 3.2);
  const body = makeBody(tpl, {
    kind: char,
    pos: _v1.set(x, y, rng.range(-0.3, 0.3)).clone(),
    vel: _v2.set(Math.cos(angle) * out, opts.up, Math.sin(angle) * out * 0.4).clone(),
    angVel: new THREE.Vector3(rng.range(-1.5, 1.5) / opts.mass, rng.range(-2.5, 2.5) / opts.mass, rng.range(-3, 3) / opts.mass),
    size: opts.size,
    mass: opts.mass,
    scale: opts.size * 0.5,
    convertDigits: binField.dpi * opts.digitsBoost,
  });
  payload.bodies.push(body);
  payload.allMeshes.push(body.mesh);
}

function spawnStroke(x, y, up) {
  const tpl = payload.strokeTemplates[Math.floor(rng.next() * payload.strokeTemplates.length)];
  const angle = rng.range(-Math.PI, Math.PI);
  const out = rng.range(1.0, 2.8);
  const body = makeBody(tpl, {
    kind: 'stroke',
    pos: _v1.set(x, y, rng.range(-0.4, 0.4)).clone(),
    vel: _v2.set(Math.cos(angle) * out, up, Math.sin(angle) * out * 0.4).clone(),
    angVel: new THREE.Vector3(rng.range(-4, 4), rng.range(-5, 5), rng.range(-6, 6)),
    size: 0.7,
    mass: 0.6,
    scale: rng.range(0.7, 1.1),
    convertDigits: binField.dpi * rng.range(0.25, 0.4),
  });
  payload.bodies.push(body);
  payload.allMeshes.push(body.mesh);
}

function triggerShake(cfg) {
  shake.active = true; shake.t = 0;
  shake.dur = cfg.dur; shake.amp = cfg.amp; shake.freq = cfg.freq;
}

function stirDust(x) {
  if (!dust) return;
  const arr = dust.geometry.attributes.position.array;
  for (let i = 0; i < arr.length; i += 3) {
    const dx = arr[i] - x;
    if (Math.abs(dx) < 4 && arr[i + 1] < GROUND_Y + 2.5) {
      arr[i + 1] += rng.range(0.2, 1.2);
      arr[i] += rng.range(-0.3, 0.3);
    }
  }
  dust.geometry.attributes.position.needsUpdate = true;
}

function forceConvertAll() {
  if (!payload) return;
  // any radicals still flying past the impact window are forced down into data
  for (const b of [...payload.bodies]) {
    if (b.state === 'flying') {
      b.pos.y = GROUND_Y + b.halfH;
      convertBody(b);
    }
  }
}

// ============================================================================
// CAMERA RIG
// ============================================================================
function updateCamera(mt, realDt) {
  const keys = CAM.keys;
  let a = keys[0], b = keys[keys.length - 1];
  if (mt <= keys[0].t) { a = b = keys[0]; }
  else if (mt >= keys[keys.length - 1].t) { a = b = keys[keys.length - 1]; }
  else {
    for (let i = 0; i < keys.length - 1; i++) {
      if (mt >= keys[i].t && mt <= keys[i + 1].t) { a = keys[i]; b = keys[i + 1]; break; }
    }
  }
  const span = Math.max(b.t - a.t, 1e-3);
  const u = clamp((mt - a.t) / span, 0, 1);
  const e = smootherstep(0, 1, u);
  const px = lerp(a.pos[0], b.pos[0], e);
  const py = lerp(a.pos[1], b.pos[1], e);
  const pz = lerp(a.pos[2], b.pos[2], e);
  const lx = lerp(a.look[0], b.look[0], e);
  const ly = lerp(a.look[1], b.look[1], e);
  const lz = lerp(a.look[2], b.look[2], e);

  // shake (decaying)
  let sx = 0, sy = 0, sz = 0;
  if (shake.active) {
    const env = Math.max(0, 1 - shake.t / shake.dur);
    const A = shake.amp * env;
    const f = shake.freq;
    sx = A * (Math.sin(mt * f) * 0.6 + Math.sin(mt * f * 2.3 + 1.7) * 0.4);
    sy = A * (Math.sin(mt * f * 1.3 + 0.7) * 0.6 + Math.sin(mt * f * 2.7 + 2.1) * 0.4);
    sz = A * (Math.sin(mt * f * 1.1 + 3.0) * 0.5);
  }

  camera.position.set(px + sx, py + sy, pz + sz);
  camLookAt.x = damp(camLookAt.x, lx, 9, realDt);
  camLookAt.y = damp(camLookAt.y, ly, 9, realDt);
  camLookAt.z = damp(camLookAt.z, lz, 9, realDt);
  camera.lookAt(camLookAt);
}

// ============================================================================
// DUST + SWEEP UPDATES
// ============================================================================
function updateDust(realDt) {
  if (!dust) return;
  dust.rotation.y += realDt * 0.02;
  // gentle bob toward base positions
  const arr = dust.geometry.attributes.position.array;
  for (let i = 0; i < arr.length; i += 3) {
    arr[i + 1] = damp(arr[i + 1], dustBase[i + 1], 0.4, realDt);
  }
  dust.geometry.attributes.position.needsUpdate = true;
}

function updateSweep(mt) {
  if (!sweepMesh) return;
  // final light grazes the ground between 11.1 and 11.9
  if (mt > 11.05 && mt < 11.95) {
    sweepMesh.visible = true;
    const u = (mt - 11.05) / 0.9;
    sweepMesh.position.x = lerp(-7.5, 7.5, u);
    const env = Math.sin(clamp(u, 0, 1) * Math.PI);
    sweepMesh.material.opacity = 0.55 * env;
  } else {
    sweepMesh.visible = false;
  }
}

// ============================================================================
// TIMELINE
// ============================================================================
function buildTimeline() {
  if (tl) { tl.kill(); tl = null; }
  const p = payload;
  const g = p.group;

  const xRest = LAYOUT.startCY + LAYOUT.xiangOffset.y;
  const fRest = LAYOUT.startCY + LAYOUT.faOffset.y;
  // landing centers so the bottom of each glyph sits on the ground
  const xLand = GROUND_Y + LAYOUT.charH * 0.5;
  const fLand = GROUND_Y + LAYOUT.charH * 0.5 - 0.1;

  tl = gsap.timeline({ paused: true });

  // --- quiet float during the opening (0–1.5s) ---
  tl.to(g.position, { y: '+=0.05', duration: T.SHOW_END, ease: 'sine.inOut' }, 0);

  // --- the fall (1.5–4.7s) ---
  // 想 heavier → lands first (~4.5)
  tl.to(p.whole.xiang.position, { y: xLand, duration: T.IMPACT1 - T.FALL_START, ease: 'power2.in' }, T.FALL_START);
  tl.to(p.whole.xiang.rotation, { z: -0.02, duration: T.IMPACT1 - T.FALL_START, ease: 'none' }, T.FALL_START);
  // 法 lighter & tilted toward 想 → lands slightly later (~4.7)
  tl.to(p.whole.fa.position, { y: fLand, duration: (T.IMPACT1 + 0.2) - T.FALL_START, ease: 'power2.in' }, T.FALL_START);
  tl.to(p.whole.fa.rotation, { z: 0.14, x: -0.04, duration: (T.IMPACT1 + 0.2) - T.FALL_START, ease: 'power1.in' }, T.FALL_START);

  // IDEA dissolves into an afterimage, doesn't take part in the impact
  tl.to(p.ideaGroup.scale, { y: 1.7, duration: 0.6, ease: 'power1.out' }, T.FALL_START + 0.15);
  tl.to(p.ideaGroup.position, { y: '+=0.6', duration: 0.7, ease: 'power1.in' }, T.FALL_START + 0.15);
  p.ideaLetters.forEach(m => {
    tl.to(m.material, { opacity: 0.0, duration: 0.55, ease: 'power2.in' }, T.FALL_START + 0.2);
  });
  tl.to(p.ideaGroup.position, { y: '-=0.4', duration: 0.3, ease: 'power2.in' }, T.FALL_START + 0.75);

  // ground rises into frame as the text falls (fromTo so it replays correctly)
  tl.fromTo(ground.position, { y: LAYOUT.groundYStart }, { y: GROUND_Y, duration: T.APPROACH_PEAK - T.FALL_START, ease: 'power1.out' }, T.FALL_START);

  // wind builds during the fall
  tl.call(() => { if (audio) audio.wind(0.0, 0.9); }, null, T.FALL_START + 0.1);
  tl.call(() => { if (audio) audio.wind(0.9, 0.0); }, null, T.APPROACH_PEAK);

  // --- first impact ---
  tl.call(impactXiang, null, T.IMPACT1);
  tl.call(impactFa, null, T.IMPACT1 + 0.2);

  // --- ensure everything is data by the end of the impact-2 window ---
  tl.call(forceConvertAll, null, T.IMPACT2_END + 0.05);
  tl.call(() => { if (audio) audio.splash(); }, null, T.IMPACT2_START + 0.05);

  // --- settle: silence returns ---
  tl.call(() => { if (audio) audio.settle(); }, null, T.SETTLE_START);
  tl.call(() => { if (audio) audio.finalPulse(); }, null, 11.4);

  // --- reveal replay ---
  tl.call(() => { if (dom.replay) dom.replay.hidden = false; }, null, T.END - 0.1);

  tl.eventCallback('onUpdate', () => { masterTime = tl.time(); });
  tl.eventCallback('onComplete', () => { playing = false; });
  return tl;
}

// ============================================================================
// RENDER LOOP
// ============================================================================
function animate() {
  requestAnimationFrame(animate);
  const realDt = Math.min(clock ? clock.getDelta() : 0.016, 0.05);

  if (tl) masterTime = tl.time();
  timeScale = slowmoScaleAt(masterTime) * approachScaleAt(masterTime);
  const dt = realDt * timeScale;

  if (shake.active) { shake.t += realDt; if (shake.t >= shake.dur) shake.active = false; }

  updateCamera(masterTime, realDt);
  updateDust(realDt);
  if (payload) updateBodies(dt);
  if (binField) binField.update(dt, realDt, masterTime);
  if (ripples) ripples.update(realDt);
  updateSweep(masterTime);

  // blue light intensity follows the binary phase
  if (blueLight) {
    let target = 0;
    if (masterTime > T.IMPACT2_START && masterTime < T.SETTLE_START + 1.4) {
      const u = clamp((masterTime - T.IMPACT2_START) / 1.0, 0, 1);
      const fade = masterTime > T.SETTLE_START ? clamp(1 - (masterTime - T.SETTLE_START) / 1.8, 0, 1) : 1;
      target = u * 2.0 * fade;
    }
    blueLight.intensity = damp(blueLight.intensity, target, 4, realDt);
  }

  if (composer) composer.render();
  else if (renderer) renderer.render(scene, camera);

  // live perf probe (downgrade once if struggling)
  if (!probedTier) {
    fpsAccum += realDt; fpsFrames++; fpsTimer += realDt;
    if (fpsTimer > 0.5) {
      const avg = (fpsAccum / Math.max(1, fpsFrames)) * 1000;
      const verdict = measureFrameQuality(avg);
      if (verdict < 0 && tierKey !== 'low') {
        downgradeTier();
      }
      probedTier = true;
    }
  }
}

function downgradeTier() {
  const order = ['high', 'medium', 'low'];
  const idx = order.indexOf(tierKey);
  if (idx <= 0) return;
  tierKey = order[idx - 1];
  tier = PERF_TIERS[tierKey];
  if (renderer) renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.dpr));
  if (bloomPass) bloomPass.strength = tier.bloomStrength;
  console.warn('downgraded perf tier ->', tierKey);
}

// ============================================================================
// PLAY / REPLAY
// ============================================================================
function startPlay() {
  buildPayload();
  buildTimeline();
  // reset effects
  if (binField) binField.reset();
  if (ripples) ripples.reset();
  if (dom.replay) dom.replay.hidden = true;
  // hide loader
  if (dom.loader) {
    dom.loader.classList.add('hide');
    setTimeout(() => { if (dom.loader) dom.loader.style.display = 'none'; }, 1000);
  }
  if (audio) audio.start();
  playing = true;
  tl.play();
}

function replay() {
  if (!fontReady) return;
  if (tl) { tl.kill(); tl = null; }
  disposePayload();
  rng.reset(0xC0FFEE + Math.floor(masterTime * 13) % 9973); // vary slightly each replay
  startPlay();
}

// ============================================================================
// RESIZE
// ============================================================================
function onResize() {
  if (!renderer || !camera) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (composer) composer.setSize(w, h);
  if (bloomPass) bloomPass.setSize(w, h);
}

// ============================================================================
// POST PROCESSING (built after renderer/camera)
// ============================================================================
function setupComposer() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (tier.bloom) {
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      tier.bloomStrength, 0.5, 0.9
    );
    composer.addPass(bloomPass);
  }
  composer.addPass(new OutputPass());
  composer.setSize(window.innerWidth, window.innerHeight);
}

// ============================================================================
// AUDIO ENGINE — minimal, synthesized, gesture-gated
// ============================================================================
function ensureAudioGesture() {
  if (audio) audio.resume();
}

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.master = null;
    this.droneNodes = null;
    this.windNode = null;
    this.noiseBuffer = null;
  }
  _ensure() {
    if (this.ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.0;
      this.master.connect(this.ctx.destination);
      // noise buffer
      const dur = 2.0;
      const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;
      return true;
    } catch (e) { return false; }
  }
  resume() {
    if (!this._ensure()) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  toggle() {
    this.enabled = !this.enabled;
    if (dom.sound) dom.sound.classList.toggle('on', this.enabled);
    if (!this._ensure()) return;
    this.resume();
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(this.enabled ? 0.9 : 0.0, this.ctx.currentTime + 0.3);
  }
  start() {
    if (!this._ensure()) return;
    this.resume();
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(this.enabled ? 0.9 : 0.0, this.ctx.currentTime + 1.2);
    this._startDrone();
  }
  _startDrone() {
    if (!this.ctx || this.droneNodes) return;
    const t = this.ctx.currentTime;
    // two low oscillators + filtered noise = ambient space
    const o1 = this.ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = 48;
    const o2 = this.ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = 64;
    const g1 = this.ctx.createGain(); g1.gain.value = 0.12;
    const g2 = this.ctx.createGain(); g2.gain.value = 0.05;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220;
    o1.connect(g1).connect(lp); o2.connect(g2).connect(lp);
    // gentle detune wobble
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = this.ctx.createGain(); lfoG.gain.value = 2.5;
    lfo.connect(lfoG).connect(o1.detune);
    o1.start(); o2.start(); lfo.start();
    lp.connect(this.master);
    this.droneNodes = { o1, o2, lfo, lp };
  }
  _noiseSource() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuffer; s.loop = true;
    return s;
  }
  wind(from, to) {
    if (!this._ensure()) return;
    const t = this.ctx.currentTime;
    const src = this._noiseSource();
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 320; bp.Q.value = 0.7;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(300, t); lp.frequency.linearRampToValueAtTime(900, t + 2.2);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(from, t); g.gain.linearRampToValueAtTime(to, t + 2.2);
    src.connect(bp).connect(lp).connect(g).connect(this.master);
    src.start(t); src.stop(t + 2.6);
  }
  impact(strength = 1) {
    if (!this._ensure()) return;
    const t = this.ctx.currentTime;
    // low thud
    const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.28);
    const og = this.ctx.createGain(); og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.9 * strength, t + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o.connect(og).connect(this.master); o.start(t); o.stop(t + 0.65);
    // dry stone crack (noise burst)
    const src = this._noiseSource();
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1600;
    const ng = this.ctx.createGain(); ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.5 * strength, t + 0.005);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    src.connect(hp).connect(ng).connect(this.master); src.start(t); src.stop(t + 0.25);
  }
  convert(size) {
    if (!this._ensure()) return;
    const t = this.ctx.currentTime;
    // small glassy tick, pitch by size
    const f = 600 + (1.5 - clamp(size, 0, 1.5)) * 900;
    const o = this.ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.14);
  }
  splash() {
    if (!this._ensure()) return;
    const t = this.ctx.currentTime;
    // liquid splash: rising filtered noise shimmer
    const src = this._noiseSource();
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(500, t); bp.frequency.exponentialRampToValueAtTime(3500, t + 0.5);
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    src.connect(bp).connect(g).connect(this.master); src.start(t); src.stop(t + 1.0);
    // digital grain layer
    const dsrc = this._noiseSource();
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
    const dg = this.ctx.createGain(); dg.gain.setValueAtTime(0.0001, t);
    dg.gain.exponentialRampToValueAtTime(0.18, t + 0.03);
    dg.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    dsrc.connect(hp).connect(dg).connect(this.master); dsrc.start(t); dsrc.stop(t + 0.8);
  }
  settle() {
    if (!this._ensure() || !this.master) return;
    const t = this.ctx.currentTime;
    // everything is absorbed into the low drone
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(this.enabled ? 0.5 : 0.0, t + 2.0);
  }
  finalPulse() {
    if (!this._ensure()) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 96;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.85);
  }
}

// ============================================================================
// PERF PROBE SCHEDULER
// ============================================================================
function schedulePerfProbe() {
  probedTier = false; fpsAccum = 0; fpsFrames = 0; fpsTimer = 0;
}

// ============================================================================
// BOOT
// ============================================================================
function boot() {
  init().catch(err => console.error(err));
}

boot();
