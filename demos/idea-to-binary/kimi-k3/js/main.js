// ============================================================================
// 想法 IDEA —— 想法 → 偏旁与笔画 → 二进制数据
// One continuous camera. Custom choreographed physics on a GSAP master clock.
// ============================================================================
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { UPM, GLYPHS } from './fontdata.js';

// ---------------------------------------------------------------- utilities
const qs = new URLSearchParams(location.search);
const SHOT = qs.has('shot') ? parseFloat(qs.get('shot')) : null; // screenshot seek
const NOAUDIO = qs.has('noaudio') || SHOT !== null;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260717);
const rr = (a, b) => a + rand() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------ configuration
const IS_COARSE = matchMedia('(pointer: coarse)').matches;
const IS_NARROW = () => innerWidth / innerHeight < 1.05;

const TIERS = {
  high: { digits: 3200, dust: 420, shadow: 2048, dpr: Math.min(devicePixelRatio, 2) },
  mid:  { digits: 1700, dust: 260, shadow: 1024, dpr: Math.min(devicePixelRatio, 1.5) },
  low:  { digits: 850,  dust: 130, shadow: 0,    dpr: 1 },
};
let tierName = qs.get('q') || (IS_COARSE ? 'mid' : 'high');
if (!TIERS[tierName]) tierName = 'high';
let T = TIERS[tierName];

// Timing (seconds, real time on the master timeline)
const TM = {
  holdEnd: 1.5,        // fall begins
  groundRise: 2.05,    // ground starts rising
  breath: 3.95,        // pre-impact slowdown ("视觉屏息")
  breathEnd: 4.38,
  impact1: 4.45,       // 想 hits (physics is authoritative; these schedule camera/fx)
  impact2: 4.68,       // 法 hits
  slowmo: 5.35,
  slowmoEnd: 6.75,
  refall: 6.9,
  splashStart: 8.1,
  outro: 9.7,
  sweep: 10.9,
  fade: 11.35,
  end: 12.0,
};

const WORLD = {
  charSize: 2.1,
  charDepth: 0.62,
  charY: 6.9,
  xiangX: -1.28,
  faX: 1.28,
  groundTop: 0,
  charG: { xiang: 1.45, fa: 1.24 },
  pieceG: 6.4,
  digitG: 7.0,
};
if (IS_NARROW()) { WORLD.charSize = 1.72; WORLD.xiangX = -1.05; WORLD.faX = 1.05; }

// Camera framing (desktop; multiplied by distFactor on narrow screens)
const distFactor = IS_NARROW() ? 1.62 : 1;
const spreadFactor = IS_NARROW() ? 0.74 : 1;

// -------------------------------------------------------------- three setup
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: SHOT !== null });
renderer.setPixelRatio(T.dpr);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;
if (T.shadow > 0) {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.FogExp2(0x000000, 0.026);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 120);

{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.06).texture;
  pmrem.dispose();
}

// lights
const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
keyLight.position.set(5, 12, 7);
if (T.shadow > 0) {
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(T.shadow, T.shadow);
  const sc = keyLight.shadow.camera;
  sc.left = -9; sc.right = 9; sc.top = 10; sc.bottom = -4; sc.near = 2; sc.far = 40;
  keyLight.shadow.bias = -0.0006;
  keyLight.shadow.radius = 4;
}
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0xdfe6f2, 0.85);
rimLight.position.set(-6, 5.5, -9);
scene.add(rimLight);

const fillLight = new THREE.AmbientLight(0x2a2d36, 0.55);
scene.add(fillLight);

// cold blue — binary phase only
const blueLight = new THREE.PointLight(0x3f74ff, 0, 26, 1.8);
blueLight.position.set(0, 3.6, 2.5);
scene.add(blueLight);
const blueFlash = new THREE.PointLight(0x5d8bff, 0, 9, 2.0);
scene.add(blueFlash);

// ---------------------------------------------------------------- materials
const ceramicMat = new THREE.MeshStandardMaterial({
  color: 0xf2f3f5, roughness: 0.46, metalness: 0.06, envMapIntensity: 0.85,
});
const ceramicMatDim = new THREE.MeshStandardMaterial({
  color: 0xdfe2e6, roughness: 0.52, metalness: 0.05, envMapIntensity: 0.7,
});

// --------------------------------------------------- glyph outline → shapes
function flattenContour(c, curveDiv = 6) {
  const pts = [];
  let cx = 0, cy = 0;
  for (const seg of c) {
    if (seg[0] === 'M') { cx = seg[1]; cy = seg[2]; pts.push([cx, cy]); }
    else if (seg[0] === 'L') { cx = seg[1]; cy = seg[2]; pts.push([cx, cy]); }
    else if (seg[0] === 'Q') {
      const [qx, qy, x, y] = [seg[1], seg[2], seg[3], seg[4]];
      for (let i = 1; i <= curveDiv; i++) {
        const t = i / curveDiv, u = 1 - t;
        pts.push([u * u * cx + 2 * u * t * qx + t * t * x, u * u * cy + 2 * u * t * qy + t * t * y]);
      }
      cx = x; cy = y;
    } else if (seg[0] === 'C') {
      const [c1x, c1y, c2x, c2y, x, y] = [seg[1], seg[2], seg[3], seg[4], seg[5], seg[6]];
      for (let i = 1; i <= curveDiv; i++) {
        const t = i / curveDiv, u = 1 - t;
        pts.push([
          u * u * u * cx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
          u * u * u * cy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
        ]);
      }
      cx = x; cy = y;
    }
  }
  return pts;
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function contourToPath(c, PathClass, k) {
  const p = new PathClass();
  for (const seg of c) {
    if (seg[0] === 'M') p.moveTo(seg[1] * k, seg[2] * k);
    else if (seg[0] === 'L') p.lineTo(seg[1] * k, seg[2] * k);
    else if (seg[0] === 'Q') p.quadraticCurveTo(seg[1] * k, seg[2] * k, seg[3] * k, seg[4] * k);
    else if (seg[0] === 'C') p.bezierCurveTo(seg[1] * k, seg[2] * k, seg[3] * k, seg[4] * k, seg[5] * k, seg[6] * k);
    else if (seg[0] === 'Z') p.closePath();
  }
  return p;
}

// Build THREE.Shapes with correct holes via contour nesting (even-odd).
function buildGlyphShapes(ch, size) {
  const g = GLYPHS[ch];
  if (!g) throw new Error('missing glyph ' + ch);
  const k = size / UPM;
  const flats = g.contours.map((c) => flattenContour(c));
  const areas = flats.map(signedArea);
  const depth = flats.map((f, i) => {
    const [px, py] = f[0];
    let d = 0;
    for (let j = 0; j < flats.length; j++) {
      if (i !== j && Math.abs(areas[j]) > Math.abs(areas[i]) && pointInPoly(px, py, flats[j])) d++;
    }
    return d;
  });
  const shapes = [];
  g.contours.forEach((c, i) => {
    if (depth[i] % 2 === 0) {
      const shape = contourToPath(c, THREE.Shape, k);
      shape.__area = Math.abs(areas[i]);
      shape.__idx = i;
      shapes.push(shape);
    }
  });
  g.contours.forEach((c, i) => {
    if (depth[i] % 2 === 1) {
      // assign to the smallest solid that contains this contour's first point
      const [px, py] = flats[i][0];
      let best = null;
      for (const s of shapes) {
        if (s.__area > Math.abs(areas[i]) && pointInPoly(px * k, py * k, s.getPoints(24).map((v) => [v.x, v.y]))) {
          if (!best || s.__area < best.__area) best = s;
        }
      }
      if (best) best.holes.push(contourToPath(c, THREE.Path, k));
    }
  });
  return shapes;
}

const geoCache = new Map();
function glyphGeometry(ch, size, depth) {
  const key = `${ch}|${size.toFixed(3)}|${depth.toFixed(3)}`;
  if (geoCache.has(key)) return geoCache.get(key);
  const shapes = buildGlyphShapes(ch, size);
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth, steps: 1, curveSegments: 5,
    bevelEnabled: true, bevelThickness: size * 0.014, bevelSize: size * 0.011, bevelSegments: 2,
  });
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -depth / 2);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geoCache.set(key, geo);
  return geo;
}

// ------------------------------------------------------------------- ground
function noiseCanvas(size, base, amp) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = base + (rand() - 0.5) * amp;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const groundRough = new THREE.CanvasTexture(noiseCanvas(256, 120, 90));
groundRough.wrapS = groundRough.wrapT = THREE.RepeatWrapping;
groundRough.repeat.set(10, 10);

const groundMat = new THREE.MeshStandardMaterial({
  color: 0x0c0c0f, roughness: 0.75, metalness: 0.05,
  roughnessMap: groundRough, envMapIntensity: 0.08,
});
const ground = new THREE.Mesh(new THREE.BoxGeometry(90, 2, 90), groundMat);
ground.position.y = -8; // rises to -1 (top at 0) during the fall
ground.receiveShadow = true;
scene.add(ground);

// faint cold rim strip at the back edge of the platform
const backRim = new THREE.Mesh(
  new THREE.PlaneGeometry(70, 0.5),
  new THREE.MeshBasicMaterial({ color: 0x1a2030, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending })
);
backRim.rotation.x = -Math.PI / 2;
backRim.position.set(0, 0.012, -16);
scene.add(backRim);

// --------------------------------------------------------------------- dust
function makeDust(count, area, size, color, opacity) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rr(-area.x, area.x);
    pos[i * 3 + 1] = rr(area.y0, area.y1);
    pos[i * 3 + 2] = rr(-area.z, area.z);
    seed[i] = rand() * 100;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color, size, transparent: true, opacity, sizeAttenuation: true,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.userData.seed = seed;
  return pts;
}
const ambientDust = makeDust(T.dust, { x: 14, y0: 0.2, y1: 9, z: 10 }, 0.035, 0x9aa2b5, 0.35);
scene.add(ambientDust);

// one-shot impact dust (gray, non-glowing feel → normal blending, low alpha)
const BURST_MAX = 520;
const burstGeo = new THREE.BufferGeometry();
burstGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BURST_MAX * 3), 3));
const burstPts = new THREE.Points(burstGeo, new THREE.PointsMaterial({
  color: 0x8d9099, size: 0.075, transparent: true, opacity: 0.5,
  sizeAttenuation: true, depthWrite: false,
}));
burstPts.frustumCulled = false;
scene.add(burstPts);
const burstPool = Array.from({ length: BURST_MAX }, () => ({ life: 0, x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0 }));
let burstCursor = 0;

function spawnDustBurst(x, y, z, n, power) {
  for (let i = 0; i < n; i++) {
    const p = burstPool[burstCursor];
    burstCursor = (burstCursor + 1) % BURST_MAX;
    const a = rand() * Math.PI * 2;
    const sp = rr(0.3, 1.6) * power;
    p.x = x + rr(-0.3, 0.3); p.y = y + rr(0, 0.15); p.z = z + rr(-0.3, 0.3);
    p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = rr(0.4, 1.8) * power;
    p.life = rr(0.7, 1.5);
  }
}

function updateDustBurst(dt) {
  const arr = burstGeo.attributes.position.array;
  for (let i = 0; i < BURST_MAX; i++) {
    const p = burstPool[i];
    if (p.life > 0) {
      p.life -= dt;
      p.vy -= 2.2 * dt;
      p.vx *= 1 - 0.8 * dt; p.vz *= 1 - 0.8 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.02) { p.y = 0.02; p.vy = 0; }
      arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
    } else {
      arr[i * 3 + 1] = -99;
    }
  }
  burstGeo.attributes.position.needsUpdate = true;
}

// ---------------------------------------------------------- title: 想法 + IDEA
const titleGroup = new THREE.Group();
scene.add(titleGroup);

const charHalf = WORLD.charSize / 2;

function makeChar(ch) {
  const geo = glyphGeometry(ch, WORLD.charSize, WORLD.charDepth);
  const mesh = new THREE.Mesh(geo, ceramicMat);
  mesh.castShadow = true;
  mesh.rotation.x = -0.02;
  return mesh;
}

const xiangMesh = makeChar('想');
xiangMesh.position.set(WORLD.xiangX, WORLD.charY, 0);
const faMesh = makeChar('法');
faMesh.position.set(WORLD.faX, WORLD.charY, 0);
titleGroup.add(xiangMesh, faMesh);

// IDEA — light, precise, wide-tracking annotation beneath the Chinese title
function ideaTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 1024, 256);
  ctx.fillStyle = 'rgba(235,238,242,0.62)';
  ctx.font = '300 118px "Helvetica Neue", Helvetica, Arial, sans-serif';
  ctx.textBaseline = 'middle';
  const word = 'IDEA';
  const tracking = 86;
  let total = 0;
  for (const ch of word) total += ctx.measureText(ch).width + tracking;
  total -= tracking;
  let x = (1024 - total) / 2;
  for (const ch of word) {
    ctx.fillText(ch, x, 140);
    x += ctx.measureText(ch).width + tracking;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const ideaMat = new THREE.MeshBasicMaterial({
  map: ideaTexture(), transparent: true, opacity: 0.85, depthWrite: false,
});
const ideaMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.65), ideaMat);
ideaMesh.position.set(0, WORLD.charY - charHalf - 0.75, 0.1);
titleGroup.add(ideaMesh);
// ghost copy for the stretched afterimage
const ideaGhost = new THREE.Mesh(ideaMesh.geometry, ideaMat.clone());
ideaGhost.material.opacity = 0;
ideaGhost.position.copy(ideaMesh.position);
titleGroup.add(ideaGhost);

// ------------------------------------------------------- break-apart pieces
// offsets are char-local (char spans -charHalf..charHalf); s = scale vs full char
const PIECE_DEFS = {
  xiang: [
    { ch: '木', dx: -0.50, dy: 0.50, s: 0.50, big: true },
    { ch: '目', dx: 0.50, dy: 0.50, s: 0.46, big: true },
    { ch: '心', dx: 0.02, dy: -0.52, s: 0.60, big: true },
    { ch: '一', dx: 0.50, dy: -0.12, s: 0.30, big: false },
    { ch: '丶', dx: -0.06, dy: 0.02, s: 0.24, big: false },
  ],
  fa: [
    { ch: '氵', dx: -0.58, dy: 0.05, s: 0.56, big: true },
    { ch: '去', dx: 0.36, dy: 0.02, s: 0.64, big: true },
    { ch: '丿', dx: 0.34, dy: 0.58, s: 0.34, big: false },
    { ch: '一', dx: 0.36, dy: 0.34, s: 0.26, big: false },
    { ch: '丶', dx: -0.58, dy: 0.58, s: 0.24, big: false },
  ],
};

const pieces = []; // live solid pieces in flight
const chars = [
  { mesh: xiangMesh, key: 'xiang', vel: 0, g: WORLD.charG.xiang, broken: false, spin: -0.012 },
  { mesh: faMesh, key: 'fa', vel: 0, g: WORLD.charG.fa, broken: false, spin: 0.055 },
];

function breakChar(char) {
  char.broken = true;
  const m = char.mesh;
  const cos = Math.cos(m.rotation.z), sin = Math.sin(m.rotation.z);
  const impactX = m.position.x;
  for (const def of PIECE_DEFS[char.key]) {
    const size = WORLD.charSize * def.s;
    const geo = glyphGeometry(def.ch, size, WORLD.charDepth * (def.big ? 0.82 : 0.55));
    const mesh = new THREE.Mesh(geo, def.big ? ceramicMat : ceramicMatDim);
    mesh.castShadow = true;
    const ox = def.dx * WORLD.charSize, oy = def.dy * WORLD.charSize;
    mesh.position.set(
      m.position.x + ox * cos - oy * sin,
      m.position.y + ox * sin + oy * cos,
      m.position.z + rr(-0.05, 0.05)
    );
    mesh.rotation.set(rr(-0.4, 0.4), rr(-0.5, 0.5), m.rotation.z + rr(-0.3, 0.3));
    scene.add(mesh);
    const outward = (mesh.position.x - impactX) * 2.3 + rr(-1.0, 1.0);
    const up = def.big ? rr(3.0, 4.6) : rr(4.2, 6.6);
    const spin = def.big ? 1.4 : 6.5;
    pieces.push({
      mesh,
      vel: new THREE.Vector3(outward * spreadFactor, up, rr(-1.2, 1.2) * spreadFactor),
      angVel: new THREE.Vector3(rr(-spin, spin), rr(-spin, spin), rr(-spin, spin)),
      r: geo.boundingSphere.radius * 0.55,
      rest: def.big ? rr(0.28, 0.42) : rr(0.45, 0.62),
      bounces: def.big ? 1 : (rand() < 0.5 ? 2 : 1),
      big: def.big,
      dead: false,
    });
  }
  m.removeFromParent();
  onImpact(char.key === 'xiang' ? 1.0 : 0.7, m.position.x, char.key === 'xiang');
}

// ----------------------------------------------------------- binary digits
// One InstancedMesh of thin 0/1 quads; choreographed liquid-splash physics.
function digitAtlas() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 256, 128);
  ctx.fillStyle = '#fff';
  ctx.font = '700 96px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('0', 64, 70);
  ctx.fillText('1', 192, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const DIGIT_MAX = T.digits;
let activeDigitCap = DIGIT_MAX;

const digitUniforms = {
  uMap: { value: digitAtlas() },
  uSweepX: { value: 999 },
  uSweepOn: { value: 0 },
  uGlobalDim: { value: 1 },
};
const digitMat = new THREE.ShaderMaterial({
  uniforms: digitUniforms,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    attribute float aGlyph;
    attribute float aBlue;
    attribute float aGlow;
    varying vec2 vUv;
    varying float vBlue;
    varying float vGlow;
    varying float vWx;
    void main() {
      vUv = uv;
      vUv.x = (vUv.x + aGlyph) * 0.5;
      vBlue = aBlue;
      vGlow = aGlow;
      vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
      vWx = wp.x;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D uMap;
    uniform float uSweepX;
    uniform float uSweepOn;
    uniform float uGlobalDim;
    varying vec2 vUv;
    varying float vBlue;
    varying float vGlow;
    varying float vWx;
    void main() {
      float a = texture2D(uMap, vUv).a;
      if (a < 0.03) discard;
      vec3 white = vec3(0.88, 0.93, 1.0);
      vec3 blue = vec3(0.36, 0.58, 1.0);
      vec3 base = mix(white, blue, vBlue);
      float sweep = smoothstep(2.6, 0.0, abs(vWx - uSweepX)) * uSweepOn;
      float b = vGlow * (1.0 + sweep * 2.4) * uGlobalDim;
      gl_FragColor = vec4(base * b, a * clamp(b, 0.0, 1.0));
    }`,
});

const digitGeo = new THREE.PlaneGeometry(0.5, 0.72);
const digitMesh = new THREE.InstancedMesh(digitGeo, digitMat, DIGIT_MAX);
digitMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
digitMesh.frustumCulled = false;
digitMesh.count = DIGIT_MAX;
scene.add(digitMesh);

const aGlyph = new THREE.InstancedBufferAttribute(new Float32Array(DIGIT_MAX), 1);
const aBlue = new THREE.InstancedBufferAttribute(new Float32Array(DIGIT_MAX), 1);
const aGlow = new THREE.InstancedBufferAttribute(new Float32Array(DIGIT_MAX), 1);
aGlow.setUsage(THREE.DynamicDrawUsage);
digitGeo.setAttribute('aGlyph', aGlyph);
digitGeo.setAttribute('aBlue', aBlue);
digitGeo.setAttribute('aGlow', aGlow);

// digit states: 0 dead · 1 flying · 2 sliding · 3 sinking · 4 drifting · 5 fading
const digits = Array.from({ length: DIGIT_MAX }, () => ({
  st: 0, x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0,
  rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0,
  s: 0.1, rest: 0.35, life: 0, glow: 0, endMode: 3, drift: 0,
}));
let digitCursor = 0;
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _sc = new THREE.Vector3();
const ZERO_M4 = new THREE.Matrix4().makeScale(0, 0, 0);
for (let i = 0; i < DIGIT_MAX; i++) digitMesh.setMatrixAt(i, ZERO_M4);

function nextDigitSlot() {
  for (let n = 0; n < activeDigitCap; n++) {
    digitCursor = (digitCursor + 1) % activeDigitCap;
    if (digits[digitCursor].st === 0) return digitCursor;
  }
  // recycle the oldest sliding/sinking one
  digitCursor = (digitCursor + 1) % activeDigitCap;
  return digitCursor;
}

function spawnBurst(x, z, power, count) {
  let spawned = 0;
  for (let i = 0; i < count; i++) {
    const idx = nextDigitSlot();
    const d = digits[idx];
    const a = rand() * Math.PI * 2;
    const mode = rand();
    let vx, vy, vz;
    if (mode < 0.52) {           // low arc — the "crown" splash
      const sp = rr(1.6, 4.4) * power;
      vx = Math.cos(a) * sp; vz = Math.sin(a) * sp * 0.8; vy = rr(1.6, 4.2) * power;
    } else if (mode < 0.8) {     // steep jets
      const sp = rr(0.2, 1.2) * power;
      vx = Math.cos(a) * sp; vz = Math.sin(a) * sp; vy = rr(4.2, 7.2) * power;
    } else {                     // ground skidders
      const sp = rr(2.8, 6.2) * power;
      vx = Math.cos(a) * sp; vz = Math.sin(a) * sp; vy = rr(0.2, 0.9);
    }
    d.x = x + rr(-0.15, 0.15); d.y = rr(0.02, 0.3); d.z = z + rr(-0.15, 0.15);
    d.vx = vx * spreadFactor; d.vy = vy; d.vz = vz * spreadFactor;
    d.rx = rand() * Math.PI * 2; d.ry = rand() * Math.PI * 2; d.rz = rand() * Math.PI * 2;
    const spin = rr(2, 9);
    d.wx = rr(-spin, spin); d.wy = rr(-spin, spin); d.wz = rr(-spin, spin);
    const big = rand() < 0.22;
    d.s = big ? rr(0.45, 0.7) : rr(0.1, 0.28);
    d.rest = rr(0.24, 0.48);
    d.life = rr(5, 9);
    d.glow = rr(1.3, 2.1);
    const em = rand();
    d.endMode = em < 0.5 ? 3 : em < 0.78 ? 4 : 5;
    d.drift = (rand() < 0.5 ? -1 : 1) * rr(0.35, 0.9);
    d.st = 1;
    aGlyph.setX(idx, rand() < 0.5 ? 0 : 1);
    aBlue.setX(idx, rand() < 0.42 ? 1 : 0);
    aGlow.setX(idx, d.glow);
    spawned++;
  }
  aGlyph.needsUpdate = true;
  aBlue.needsUpdate = true;
  return spawned;
}

function updateDigits(dt) {
  const G = WORLD.digitG;
  for (let i = 0; i < activeDigitCap; i++) {
    const d = digits[i];
    if (d.st === 0) continue;
    if (d.st === 1) { // flying
      d.vy -= G * dt;
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      d.rx += d.wx * dt; d.ry += d.wy * dt; d.rz += d.wz * dt;
      if (d.y <= 0.02) {
        d.y = 0.02;
        d.vy = -d.vy * d.rest;
        d.vx *= 0.62; d.vz *= 0.62;
        d.wx *= 0.45; d.wy *= 0.45; d.wz *= 0.45;
        if (Math.abs(d.vy) < 1.0) {
          d.st = 2;
          // lay flat on the ground
          d.rx = -Math.PI / 2 + rr(-0.15, 0.15);
          d.wx = d.wy = d.wz = 0;
        }
      }
    } else if (d.st === 2) { // sliding
      d.vx *= 1 - 2.1 * dt; d.vz *= 1 - 2.1 * dt;
      d.x += d.vx * dt; d.z += d.vz * dt;
      d.life -= dt;
      if (d.life <= 0) d.st = d.endMode;
    } else if (d.st === 3) { // sinking into the black ground
      d.y -= 0.32 * dt;
      d.glow -= dt * 1.1;
      if (d.glow <= 0) d.st = 0;
    } else if (d.st === 4) { // drifting away as faint data current
      d.x += d.drift * dt;
      d.glow = Math.max(0.2, d.glow - dt * 0.5);
      d.life -= dt * 0.6;
      if (d.life <= -1.5) d.st = 0;
    } else if (d.st === 5) { // winking out
      d.glow -= dt * 1.7;
      if (d.glow <= 0) d.st = 0;
    }
    if (d.st === 0) {
      digitMesh.setMatrixAt(i, ZERO_M4);
      aGlow.setX(i, 0);
      continue;
    }
    const speed = d.st === 1 ? Math.abs(d.vy) + Math.hypot(d.vx, d.vz) : 0;
    const stretch = 1 + Math.min(0.55, speed * 0.045);
    _p.set(d.x, d.y, d.z);
    _e.set(d.rx, d.ry, d.rz);
    _q.setFromEuler(_e);
    _sc.set(d.s, d.s * stretch, d.s);
    _m4.compose(_p, _q, _sc);
    digitMesh.setMatrixAt(i, _m4);
    aGlow.setX(i, Math.max(0, d.glow));
  }
  digitMesh.instanceMatrix.needsUpdate = true;
  aGlow.needsUpdate = true;
}

// -------------------------------------------------------------- impact FX
const shake = { amp: 0 };
function kick(a) { shake.amp = Math.max(shake.amp, a); }

const rings = [];
function spawnRing(x, z, strength) {
  const geo = new THREE.RingGeometry(0.86, 1, 72);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x9aa3b8, transparent: true, opacity: 0.32 * strength,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false,
  });
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, 0.02, z);
  scene.add(m);
  rings.push({ m, t: 0, strength });
}

function updateRings(dt) {
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.t += dt;
    const k = r.t / 0.7;
    if (k >= 1) {
      scene.remove(r.m);
      r.m.geometry.dispose(); r.m.material.dispose();
      rings.splice(i, 1);
      continue;
    }
    const s = 1 + k * 7.5 * r.strength;
    r.m.scale.set(s, s, 1);
    r.m.material.opacity = 0.22 * r.strength * (1 - k) * (1 - k);
  }
}

let flashDecay = 0;
function onImpact(strength, x, isFirst) {
  kick(0.35 * strength);
  spawnRing(x, 0, strength);
  spawnDustBurst(x, 0.05, 0, Math.round(90 * strength), 1.6 * strength);
  if (!NOAUDIO) Audio8.impact(strength);
  if (isFirst && !NOAUDIO) Audio8.stopWind();
}

// ------------------------------------------------------------------- audio
const Audio8 = {
  ctx: null, master: null, windGain: null, windFilter: null, started: false,
  init() {
    if (this.started || NOAUDIO) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
      this.started = true;
      this._ambient();
      this._wind();
    } catch (e) { /* audio unavailable — visuals carry the piece */ }
  },
  _noiseBuffer(sec = 2) {
    const n = this.ctx.sampleRate * sec;
    const b = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  },
  _ambient() {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(3); src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 210; lp.Q.value = 0.4;
    const g = this.ctx.createGain(); g.gain.value = 0.045;
    src.connect(lp).connect(g).connect(this.master);
    src.start();
  },
  _wind() {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(2); src.loop = true;
    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass'; this.windFilter.frequency.value = 260; this.windFilter.Q.value = 0.7;
    this.windGain = this.ctx.createGain(); this.windGain.gain.value = 0;
    src.connect(this.windFilter).connect(this.windGain).connect(this.master);
    src.start();
  },
  setWind(v) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(0.16 * clamp(v, 0, 1), t, 0.12);
    this.windFilter.frequency.setTargetAtTime(240 + 700 * clamp(v, 0, 1), t, 0.15);
  },
  stopWind() {
    if (!this.started) return;
    this.windGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.25);
  },
  _burst(type, freq, q, dur, gain, when = 0, sweepTo = null) {
    const t0 = this.ctx.currentTime + when;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(Math.max(0.2, dur + 0.1));
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t0); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t0); src.stop(t0 + dur + 0.1);
  },
  _tone(wave, f0, f1, dur, gain, when = 0) {
    const t0 = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    o.type = wave;
    o.frequency.setValueAtTime(f0, t0);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  },
  impact(strength = 1) { // heavy dry stone hit + wood/ceramic crack layers
    if (!this.started) return;
    this._tone('sine', 64 * strength, 30, 0.5, 0.85);
    this._burst('lowpass', 850, 0.6, 0.32, 0.5 * strength);
    this._burst('highpass', 2100, 0.8, 0.07, 0.16 * strength, 0.02);
    this._burst('bandpass', 1300, 1.4, 0.1, 0.2 * strength, 0.05);
    this._burst('highpass', 2600, 0.9, 0.05, 0.1 * strength, 0.09);
  },
  clatter(size01) { // small sharp collisions; pitch by fragment size
    if (!this.started) return;
    const f = 900 + (1 - size01) * 1500 + Math.random() * 300;
    this._tone('triangle', f, f * 0.6, 0.09 + 0.1 * size01, 0.10);
    this._burst('highpass', f * 1.8, 1, 0.04, 0.05);
  },
  digital(power = 1) { // granular blips + a liquid splash sweep
    if (!this.started) return;
    const n = 7 + Math.floor(Math.random() * 7);
    for (let i = 0; i < n; i++) {
      const f = 1200 + Math.random() * 3200;
      this._tone('square', f, f * 0.8, 0.02 + Math.random() * 0.035, 0.028 * power, Math.random() * 0.2);
    }
    this._burst('bandpass', 1400, 1.1, 0.3, 0.1 * power, 0, 420);
  },
  outroPulse() {
    if (!this.started) return;
    this._tone('sine', 620, 610, 1.6, 0.022);
    this._tone('sine', 1240, 1220, 1.1, 0.012, 0.35);
  },
};

// audio requires a user gesture on most browsers — start muted-ambience on tap
const audioHint = document.getElementById('audio-hint');
function armAudio() {
  if (!NOAUDIO && (!Audio8.started || Audio8.ctx.state === 'suspended')) {
    Audio8.init();
    if (Audio8.ctx && Audio8.ctx.state === 'suspended') Audio8.ctx.resume();
    audioHint.classList.remove('show');
  }
}
addEventListener('pointerdown', armAudio, { once: false });
addEventListener('keydown', armAudio, { once: false });
if (!NOAUDIO) setTimeout(() => { if (!Audio8.started) audioHint.classList.add('show'); }, 2600);

// ------------------------------------------------------------------ camera
const cam = { px: 0, py: 5.25, pz: 13.6 * distFactor, tx: 0, ty: 5.55, tz: 0 };
let fallFollow = false;   // per-frame follow while the chars fall
let outroDrift = false;

// --------------------------------------------------------------- timescale
const timeCtl = { scale: 1 };

// ------------------------------------------------------------- master clock
const tl = gsap.timeline({ defaults: { overwrite: 'auto' } });
const breakTimes = {}; // measured, for the record

// ground rises out of the dark to meet the falling title
tl.to(ground.position, { y: -1, duration: 2.35, ease: 'power1.in' }, TM.groundRise);
tl.to(backRim.material, { opacity: 0.5, duration: 2.0, ease: 'sine.inOut' }, TM.groundRise + 0.4);

// camera: slow push as the fall begins (follow itself is per-frame)
tl.to(cam, { pz: 11.8 * distFactor, duration: 3.0, ease: 'power1.in' }, TM.holdEnd);

// pre-impact held breath
tl.to(timeCtl, { scale: 0.55, duration: 0.3, ease: 'sine.out' }, TM.breath);
tl.to(timeCtl, { scale: 1.0, duration: 0.18, ease: 'sine.in' }, TM.breathEnd);

// after first break: push in and settle into slow motion
tl.to(timeCtl, { scale: 0.3, duration: 0.4, ease: 'power2.out' }, TM.slowmo);
tl.to(cam, { pz: 9.7 * distFactor, py: 2.7, ty: 1.7, tx: 0, duration: 1.15, ease: 'power2.out' }, TM.impact1 + 0.15);
tl.to(rimLight, { intensity: 1.8, duration: 0.9, ease: 'sine.out' }, TM.slowmo);

// gravity takes over again
tl.to(timeCtl, { scale: 1.12, duration: 0.5, ease: 'power2.in' }, TM.slowmoEnd);
tl.to(timeCtl, { scale: 1.0, duration: 0.6, ease: 'sine.out' }, TM.refall + 0.7);
tl.to(cam, { pz: 12.1 * distFactor, py: 2.1, ty: 0.9, duration: 1.5, ease: 'sine.inOut' }, TM.refall);
tl.to(rimLight, { intensity: 0.85, duration: 1.2 }, TM.slowmoEnd);

// binary phase: the cold blue arrives, restrained
tl.to(blueLight, { intensity: 1.6, duration: 1.4, ease: 'sine.inOut' }, TM.splashStart);
tl.to(blueLight, { intensity: 0.45, duration: 2.2, ease: 'sine.inOut' }, TM.splashStart + 1.6);

// outro: pull far back, everything settles
tl.to(cam, { pz: 17.5 * distFactor, py: 4.4, ty: 0.7, duration: 2.5, ease: 'power1.inOut' }, TM.outro);
tl.call(() => { outroDrift = true; }, null, TM.outro);

// final thin light sweeping under the last digits
tl.to(digitUniforms.uSweepOn, { value: 1, duration: 0.25 }, TM.sweep);
tl.fromTo(digitUniforms.uSweepX, { value: -16 * spreadFactor }, { value: 16 * spreadFactor, duration: 1.0, ease: 'sine.inOut' }, TM.sweep);
tl.to(digitUniforms.uSweepOn, { value: 0, duration: 0.6 }, TM.sweep + 0.7);
tl.call(() => { if (!NOAUDIO) Audio8.outroPulse(); }, null, TM.sweep);

// fade to black, then offer replay
const fadeEl = document.getElementById('fadeout');
const replayBtn = document.getElementById('replay');
tl.to(digitUniforms.uGlobalDim, { value: 0.25, duration: 1.4, ease: 'sine.in' }, TM.fade - 0.4);
tl.to(fadeEl, { opacity: 1, duration: 1.1, ease: 'sine.in' }, TM.fade);
tl.to(blueLight, { intensity: 0, duration: 1.0 }, TM.fade);
tl.call(() => { replayBtn.classList.add('show'); }, null, TM.end);
replayBtn.addEventListener('click', () => location.reload());

// ------------------------------------------------------------ physics step
let phase = 'idle'; // idle → fall → broken
const ideaState = { gone: false };

function stepChars(dt, simT) {
  if (phase === 'idle') return;
  let allBroken = true;
  for (const c of chars) {
    if (c.broken) continue;
    allBroken = false;
    c.vel += c.g * dt;
    c.vel *= 1 / (1 + 0.05 * dt); // whisper of air resistance
    c.mesh.position.y -= c.vel * dt;
    // 想 drops straighter & heavier; 法 leans toward 想 as it falls
    const targetTilt = c.key === 'fa' ? 0.17 : -0.02;
    c.mesh.rotation.z += (targetTilt - c.mesh.rotation.z) * dt * (c.key === 'fa' ? 1.4 : 0.6);
    // faint edge tremble
    c.mesh.rotation.x = -0.02 + Math.sin(simT * 43 + (c.key === 'fa' ? 2 : 0)) * 0.004;
    c.mesh.rotation.y = Math.sin(simT * 31) * 0.004;
    if (!NOAUDIO) Audio8.setWind(c.vel / 6);
    const bottom = c.mesh.position.y - charHalf * 0.92;
    if (bottom <= WORLD.groundTop) {
      breakTimes[c.key] = simT;
      breakChar(c);
      if (c.key === 'xiang') phase = 'broken';
    }
  }
  if (allBroken) phase = 'broken';
}

function stepPieces(dt) {
  for (const p of pieces) {
    if (p.dead) continue;
    p.vel.y -= WORLD.pieceG * dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    p.mesh.rotation.x += p.angVel.x * dt;
    p.mesh.rotation.y += p.angVel.y * dt;
    p.mesh.rotation.z += p.angVel.z * dt;
    if (p.mesh.position.y - p.r <= WORLD.groundTop + 0.01 && p.vel.y < 0) {
      p.mesh.position.y = WORLD.groundTop + 0.01 + p.r;
      // no digit conversion before the second-impact phase — keep bouncing
      if (p.bounces > 0 || simT < TM.refall + 0.55) {
        if (p.bounces > 0) p.bounces--;
        p.vel.y = -p.vel.y * p.rest;
        p.vel.x *= 0.7; p.vel.z *= 0.7;
        p.angVel.multiplyScalar(0.55);
        if (!NOAUDIO) Audio8.clatter(p.r);
        spawnDustBurst(p.mesh.position.x, 0.03, p.mesh.position.z, 8, 0.5);
      } else {
        // second impact — the piece shatters into a binary splash
        p.dead = true;
        scene.remove(p.mesh);
        const count = Math.round(clamp(p.r * (p.big ? 300 : 170), 50, p.big ? 300 : 150));
        spawnBurst(p.mesh.position.x, p.mesh.position.z, p.big ? rr(0.9, 1.15) : rr(0.55, 0.8), count);
        blueFlash.position.set(p.mesh.position.x, 0.9, p.mesh.position.z + 0.5);
        blueFlash.intensity = p.big ? 4.0 : 1.8;
        flashDecay = Math.max(flashDecay, p.big ? 4.0 : 1.8);
        if (p.big) kick(0.07);
        spawnDustBurst(p.mesh.position.x, 0.04, p.mesh.position.z, p.big ? 26 : 12, 0.8);
        if (!NOAUDIO) Audio8.digital(p.big ? 1 : 0.6);
        p.mesh.geometry.dispose();
      }
    }
  }
}

// --------------------------------------------------------------- main loop
let simT = 0;
let lastReal = null;
let fpsAcc = 0, fpsN = 0, fpsChecked = false;

function tick(dt) {
  simT += dt;

  if (phase === 'idle' && simT >= TM.holdEnd) {
    phase = 'fall';
    fallFollow = true;
    // IDEA lags behind: stretched ghost, then gone — it never hits the ground
    gsap.to(ideaMesh.material, { opacity: 0, duration: 1.1, ease: 'power2.in', delay: 0.12 });
    gsap.to(ideaMesh.scale, { y: 1.9, duration: 1.1, ease: 'power2.in', delay: 0.12 });
    gsap.to(ideaMesh.position, { y: ideaMesh.position.y + 0.5, duration: 1.1, ease: 'power1.in', delay: 0.12 });
    gsap.to(ideaGhost.material, { opacity: 0.28, duration: 0.25, delay: 0.1 });
    gsap.to(ideaGhost.material, { opacity: 0, duration: 0.7, ease: 'power2.in', delay: 0.35 });
    gsap.to(ideaGhost.scale, { y: 2.6, duration: 0.9, ease: 'power2.in', delay: 0.1 });
    gsap.to(ideaGhost.position, { y: ideaGhost.position.y + 0.9, duration: 0.9, ease: 'power1.in', delay: 0.1 });
  }

  stepChars(dt, simT);
  stepPieces(dt);
  updateDigits(dt);
  updateDustBurst(dt);
  updateRings(dt);

  // ambient dust drift
  const dp = ambientDust.geometry.attributes.position;
  const seeds = ambientDust.userData.seed;
  for (let i = 0; i < dp.count; i++) {
    dp.array[i * 3] += Math.sin(simT * 0.14 + seeds[i]) * 0.0007;
    dp.array[i * 3 + 1] += 0.0011 + Math.cos(simT * 0.1 + seeds[i] * 1.7) * 0.0005;
    if (dp.array[i * 3 + 1] > 9.5) dp.array[i * 3 + 1] = 0.1;
  }
  dp.needsUpdate = true;

  // blue flash decay
  if (flashDecay > 0) {
    flashDecay = Math.max(0, flashDecay - dt * 14);
    blueFlash.intensity = flashDecay;
  }

  // camera per-frame: follow during the fall, shake, breathing
  if (fallFollow && phase === 'fall') {
    const avgY = (chars[0].mesh.position.y + chars[1].mesh.position.y) / 2;
    const targetPy = clamp(avgY * 0.55 + 0.9, 1.75, 5.25);
    const targetTy = clamp(avgY * 0.62, 1.0, 5.55);
    cam.py += (targetPy - cam.py) * Math.min(1, dt * 1.75);
    cam.ty += (targetTy - cam.ty) * Math.min(1, dt * 2.6);
  }
  if (outroDrift) cam.px = Math.sin(simT * 0.1) * 0.4;

  shake.amp *= Math.exp(-dt * 6.5);
  const s = shake.amp;
  const sx = (Math.sin(simT * 39.7) + Math.sin(simT * 23.3)) * 0.5 * s;
  const sy = (Math.sin(simT * 33.1) + Math.sin(simT * 47.9)) * 0.5 * s;
  const breath = phase === 'idle' ? Math.sin(simT * 0.55) * 0.045 : 0;

  camera.position.set(cam.px + sx, cam.py + sy + breath, cam.pz);
  camera.lookAt(cam.tx + sx * 0.4, cam.ty + sy * 0.4, cam.tz);
  camera.rotation.z += Math.sin(simT * 27.3) * s * 0.12;
}

function render() {
  renderer.render(scene, camera);
}

// fps watchdog: drop particle budget + resolution if the device struggles
function fpsWatch(realDt) {
  if (fpsChecked || SHOT !== null) return;
  if (simT < 2 || simT > 5) return;
  fpsAcc += realDt; fpsN++;
  if (fpsN >= 90) {
    fpsChecked = true;
    const fps = fpsN / fpsAcc;
    if (fps < 38 && tierName !== 'low') {
      const next = tierName === 'high' ? 'mid' : 'low';
      tierName = next; T = TIERS[next];
      activeDigitCap = Math.min(activeDigitCap, T.digits);
      renderer.setPixelRatio(T.dpr);
      ambientDust.material.opacity = 0.22;
      console.info('[idea] performance tier lowered to', next, 'fps=', fps.toFixed(1));
    }
  }
}

function loop(now) {
  const realDt = Math.min((now - (lastReal ?? now)) / 1000, 0.05);
  lastReal = now;
  fpsWatch(realDt);
  tick(realDt * timeCtl.scale);
  render();
  requestAnimationFrame(loop);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------- shot mode
// ?shot=SECONDS fast-forwards deterministically and pauses on one frame.
if (SHOT !== null) {
  const step = 1 / 60;
  // step the whole global timeline so ad-hoc tweens created inside tick
  // (IDEA fade/ghost) advance together with the master timeline `tl`
  gsap.globalTimeline.pause();
  let t = 0;
  let gT = gsap.globalTimeline.time();
  while (t < SHOT) {
    const dt = Math.min(step, SHOT - t);
    gT += dt;
    // keep every timeline in lock-step with the simulated clock
    gsap.globalTimeline.time(gT, false);
    tick(dt * timeCtl.scale);
    t += dt;
  }
  render();
  // keep presenting the frozen frame — headless capture needs live composites
  (function holdFrame() { render(); requestAnimationFrame(holdFrame); })();
  window.__shotReady = true;
  window.__breakTimes = breakTimes;
  console.log('[idea] shot at', SHOT.toFixed(2), 'breakTimes', JSON.stringify(breakTimes));
} else {
  tick(0); // frame the camera before the first presented frame
  render();
  requestAnimationFrame(loop);
}
