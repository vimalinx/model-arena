import * as THREE from 'three';

// ============================================================
// CONSTANTS
// ============================================================
const WORLD_SIZE   = 32;
const WORLD_HEIGHT = 32;
const GRAVITY      = 25;
const JUMP_SPEED   = 8.5;
const MOVE_SPEED   = 7;
const MOUSE_SENS   = 0.002;
const PLAYER_W     = 0.6;
const PLAYER_H     = 1.8;
const EYE_H        = 1.6;
const REACH        = 6;

// Block types
const AIR    = 0;
const GRASS  = 1;
const DIRT   = 2;
const STONE  = 3;
const WOOD   = 4;
const LEAVES = 5;
const BLOCK_NAMES = ['Air','Grass','Dirt','Stone','Wood','Leaves'];

// Per-face colors so grass has green top, etc.
const COLORS = {
  [GRASS]:  { top: 0x5d8c3e, side: 0x8b6b4a, bot: 0x6b4c3b },
  [DIRT]:   { top: 0x8b6b4a, side: 0x8b6b4a, bot: 0x6b4c3b },
  [STONE]:  { top: 0x888888, side: 0x808080, bot: 0x707070 },
  [WOOD]:   { top: 0xc4a45a, side: 0x9e7d3f, bot: 0x8b6914 },
  [LEAVES]: { top: 0x3a8c2c, side: 0x348024, bot: 0x2a6018 },
};

// Block preview colors (solid for hotbar)
const BLOCK_COLORS_SOLID = {
  [GRASS]:  0x5d8c3e,
  [DIRT]:   0x8b6b4a,
  [STONE]:  0x808080,
  [WOOD]:   0xc4a45a,
  [LEAVES]: 0x3a8c2c,
};

// ============================================================
// WORLD DATA
// ============================================================
const worldData = new Uint8Array(WORLD_SIZE * WORLD_HEIGHT * WORLD_SIZE);

function idx(x, y, z) {
  return x + y * WORLD_SIZE + z * WORLD_SIZE * WORLD_HEIGHT;
}

function getBlock(x, y, z) {
  if (x < 0 || x >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT || z < 0 || z >= WORLD_SIZE) return AIR;
  return worldData[idx(x, y, z)];
}

function setBlock(x, y, z, type) {
  if (x < 0 || x >= WORLD_SIZE || y < 0 || y >= WORLD_HEIGHT || z < 0 || z >= WORLD_SIZE) return;
  worldData[idx(x, y, z)] = type;
}

// ============================================================
// TERRAIN GENERATION
// ============================================================
function generateWorld() {
  for (let x = 0; x < WORLD_SIZE; x++) {
    for (let z = 0; z < WORLD_SIZE; z++) {
      const nx = x / WORLD_SIZE - 0.5;
      const nz = z / WORLD_SIZE - 0.5;
      const h = Math.max(1, Math.floor(6 +
        Math.sin(nx * 8) * Math.cos(nz * 8) * 3 +
        Math.sin(nx * 14 + nz * 10) * 2 +
        Math.cos(nx * 5 - nz * 7) * 1.5 +
        Math.sin(nz * 12) * 1
      ));
      for (let y = 0; y < h; y++) {
        let type = STONE;
        if (y === h - 1)           type = GRASS;
        else if (y > h - 4)        type = DIRT;
        setBlock(x, y, z, type);
      }
    }
  }

  // Trees
  for (let x = 2; x < WORLD_SIZE - 2; x++) {
    for (let z = 2; z < WORLD_SIZE - 2; z++) {
      if (Math.random() < 0.035) {
        let gy = -1;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          if (getBlock(x, y, z) !== AIR) { gy = y; break; }
        }
        if (gy >= 0) placeTree(x, gy + 1, z);
      }
    }
  }
}

function placeTree(x, y, z) {
  const th = 3 + Math.floor(Math.random() * 3);
  for (let ty = 0; ty < th; ty++) setBlock(x, y + ty, z, WOOD);
  const lb = y + th - 1;
  for (let dy = -1; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) + Math.abs(dz) + Math.abs(dy) > 3) continue;
        const lx = x + dx, ly = lb + dy, lz = z + dz;
        if (getBlock(lx, ly, lz) === AIR) setBlock(lx, ly, lz, LEAVES);
      }
    }
  }
}

// ============================================================
// MESH BUILDER — merged geometry with vertex colors
// ============================================================

// CCW face quads, unit cube. Verified normals face outward.
const FACES = {
  '+y': { verts: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]], color: 'top' },
  '-y': { verts: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]], color: 'bot' },
  '+x': { verts: [[1,1,1],[1,0,1],[1,0,0],[1,1,0]], color: 'side' },
  '-x': { verts: [[0,1,0],[0,0,0],[0,0,1],[0,1,1]], color: 'side' },
  '+z': { verts: [[0,1,1],[0,0,1],[1,0,1],[1,1,1]], color: 'side' },
  '-z': { verts: [[1,1,0],[1,0,0],[0,0,0],[0,1,0]], color: 'side' },
};

const FACE_NAMES = ['+y','-y','+x','-x','+z','-z'];
const FACE_DIR  = [
  [ 0, 1, 0, +1],[ 0,-1, 0, -1],
  [ 1, 0, 0, +1],[-1, 0, 0, -1],
  [ 0, 0, 1, +1],[ 0, 0,-1, -1],
];

function buildWorldMesh(scene) {
  const positions = [];
  const colors    = [];

  for (let x = 0; x < WORLD_SIZE; x++) {
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let z = 0; z < WORLD_SIZE; z++) {
        const block = worldData[idx(x, y, z)];
        if (block === AIR) continue;

        const palette = COLORS[block];
        for (let fi = 0; fi < 6; fi++) {
          const fDef = FACES[FACE_NAMES[fi]];
          const [dx, dy, dz] = FACE_DIR[fi];
          if (getBlock(x + dx, y + dy, z + dz) !== AIR) continue;

          const cHex = palette[fDef.color];
          const cr = ((cHex >> 16) & 0xff) / 255;
          const cg = ((cHex >>  8) & 0xff) / 255;
          const cb = ( cHex        & 0xff) / 255;

          const vs = fDef.verts; // [v0,v1,v2,v3] CCW
          // Tri 0: v0, v1, v2
          for (const v of [0, 1, 2]) pushVert(positions, colors, x, y, z, vs[v], cr, cg, cb);
          // Tri 1: v2, v3, v0
          for (const v of [2, 3, 0]) pushVert(positions, colors, x, y, z, vs[v], cr, cg, cb);
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors,    3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);
  return mesh;
}

function pushVert(positions, colors, x, y, z, [vx, vy, vz], r, g, b) {
  positions.push(x + vx, y + vy, z + vz);
  colors.push(r, g, b);
}

// ============================================================
// VOXEL RAYCAST (Amanatides-Woo)
// ============================================================
function raycastVoxel(origin, dir, maxDist) {
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  if (getBlock(x, y, z) !== AIR) {
    // Started inside a block — skip to next
  }

  const sx = dir.x > 0 ? 1 : -1;
  const sy = dir.y > 0 ? 1 : -1;
  const sz = dir.z > 0 ? 1 : -1;

  const tDx = Math.abs(1 / (dir.x || 1e-9));
  const tDy = Math.abs(1 / (dir.y || 1e-9));
  const tDz = Math.abs(1 / (dir.z || 1e-9));

  let tMx = (dir.x > 0 ? (x + 1 - origin.x) : (origin.x - x)) * tDx;
  let tMy = (dir.y > 0 ? (y + 1 - origin.y) : (origin.y - y)) * tDy;
  let tMz = (dir.z > 0 ? (z + 1 - origin.z) : (origin.z - z)) * tDz;

  let face = -1;

  for (let i = 0; i < maxDist * 10; i++) {
    if (getBlock(x, y, z) !== AIR) {
      return { x, y, z, face, block: getBlock(x, y, z) };
    }

    if (tMx < tMy && tMx < tMz) {
      if (tMx > maxDist) break;
      x += sx; tMx += tDx;
      face = sx > 0 ? 3 : 2; // -x or +x
    } else if (tMy < tMz) {
      if (tMy > maxDist) break;
      y += sy; tMy += tDy;
      face = sy > 0 ? 1 : 0; // -y or +y
    } else {
      if (tMz > maxDist) break;
      z += sz; tMz += tDz;
      face = sz > 0 ? 5 : 4; // -z or +z
    }
  }
  return null;
}

// ============================================================
// THREE.JS SETUP
// ============================================================
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, WORLD_SIZE * 0.6, WORLD_SIZE * 1.8);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200);
camera.rotation.order = 'YXZ';

// Lighting
scene.add(new THREE.AmbientLight(0x8899bb, 0.6));
const sun = new THREE.DirectionalLight(0xfff5e8, 1.0);
sun.position.set(60, 80, 40);
scene.add(sun);

// Generate world
generateWorld();
let worldMesh = buildWorldMesh(scene);

// Highlight
const hlGeo = new THREE.BoxGeometry(1.002, 1.002, 1.002);
const hlMesh = new THREE.LineSegments(
  new THREE.EdgesGeometry(hlGeo),
  new THREE.LineBasicMaterial({ color: 0x000000 })
);
hlMesh.visible = false;
scene.add(hlMesh);

// ============================================================
// PLAYER STATE
// ============================================================
const player = {
  pos: new THREE.Vector3(WORLD_SIZE/2, 100, WORLD_SIZE/2), // will snap to ground
  vel: new THREE.Vector3(),
  onGround: false,
  yaw: 0,
  pitch: 0,
};

// Find spawn Y
{
  let sy = WORLD_HEIGHT - 1;
  while (sy > 0 && getBlock(Math.floor(player.pos.x), sy, Math.floor(player.pos.z)) === AIR) sy--;
  player.pos.y = sy + 2;
}

// ============================================================
// INPUT
// ============================================================
const keys = {};
let pointerLocked = false;
let selectedBlock = GRASS;

document.addEventListener('keydown', e => {
  keys[e.code] = true;
  // Block selection
  if (e.code >= 'Digit1' && e.code <= 'Digit5') {
    selectedBlock = parseInt(e.code[5]);
  }
});
document.addEventListener('keyup', e => { keys[e.code] = false; });

// Pointer lock
const blocker = document.getElementById('blocker');
const hud     = document.getElementById('hud');

blocker.addEventListener('click', () => {
  renderer.domElement.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
  blocker.style.display = pointerLocked ? 'none' : 'flex';
  hud.style.display     = pointerLocked ? 'block' : 'none';
});

document.addEventListener('mousemove', e => {
  if (!pointerLocked) return;
  player.yaw   -= e.movementX * MOUSE_SENS;
  player.pitch -= e.movementY * MOUSE_SENS;
  player.pitch  = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, player.pitch));
});

// Block breaking / placing
document.addEventListener('mousedown', e => {
  if (!pointerLocked) return;
  const dir = getLookDir();
  const origin = new THREE.Vector3(player.pos.x, player.pos.y + EYE_H, player.pos.z);
  const hit = raycastVoxel(origin, dir, REACH);

  if (e.button === 0 && hit) { // left — break
    setBlock(hit.x, hit.y, hit.z, AIR);
    rebuildWorldMesh();
  } else if (e.button === 2 && hit && hit.face >= 0) { // right — place
    const [dx, dy, dz] = FACE_DIR[hit.face];
    const px = hit.x + dx, py = hit.y + dy, pz = hit.z + dz;
    if (px >= 0 && px < WORLD_SIZE && py >= 0 && py < WORLD_HEIGHT && pz >= 0 && pz < WORLD_SIZE) {
      if (!playerCollidesWithBlock(px, py, pz)) {
        setBlock(px, py, pz, selectedBlock);
        rebuildWorldMesh();
      }
    }
  }
});

document.addEventListener('contextmenu', e => e.preventDefault());

function getLookDir() {
  const dir = new THREE.Vector3(0, 0, -1);
  dir.applyQuaternion(new THREE.Quaternion().setFromEuler(
    new THREE.Euler(player.pitch, player.yaw, 0, 'YXZ')
  ));
  return dir;
}

// ============================================================
// PLAYER COLLISION
// ============================================================
function playerCollidesWithBlock(bx, by, bz) {
  // Player bounding box (AABB)
  const pMinX = player.pos.x - PLAYER_W / 2;
  const pMaxX = player.pos.x + PLAYER_W / 2;
  const pMinY = player.pos.y;
  const pMaxY = player.pos.y + PLAYER_H;
  const pMinZ = player.pos.z - PLAYER_W / 2;
  const pMaxZ = player.pos.z + PLAYER_W / 2;

  // Block occupies [bx, bx+1] × [by, by+1] × [bz, bz+1]
  return pMinX < bx + 1 && pMaxX > bx &&
         pMinY < by + 1 && pMaxY > by &&
         pMinZ < bz + 1 && pMaxZ > bz;
}

function checkCollision(px, py, pz) {
  const pMinX = px - PLAYER_W / 2;
  const pMaxX = px + PLAYER_W / 2;
  const pMinY = py;
  const pMaxY = py + PLAYER_H;
  const pMinZ = pz - PLAYER_W / 2;
  const pMaxZ = pz + PLAYER_W / 2;

  const bx0 = Math.floor(pMinX);
  const bx1 = Math.floor(pMaxX - 1e-6);
  const by0 = Math.floor(pMinY);
  const by1 = Math.floor(pMaxY - 1e-6);
  const bz0 = Math.floor(pMinZ);
  const bz1 = Math.floor(pMaxZ - 1e-6);

  for (let bx = bx0; bx <= bx1; bx++) {
    for (let by = by0; by <= by1; by++) {
      for (let bz = bz0; bz <= bz1; bz++) {
        if (getBlock(bx, by, bz) !== AIR) return true;
      }
    }
  }
  return false;
}

// ============================================================
// WORLD REBUILD
// ============================================================
function rebuildWorldMesh() {
  if (worldMesh) {
    worldMesh.geometry.dispose();
    worldMesh.material.dispose();
    scene.remove(worldMesh);
  }
  worldMesh = buildWorldMesh(scene);
}

// ============================================================
// HUD HOTBAR
// ============================================================
function buildHotbar() {
  const bar = document.getElementById('hotbar');
  bar.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const slot = document.createElement('div');
    slot.className = 'hotbar-slot' + (i === selectedBlock ? ' selected' : '');
    const color = document.createElement('div');
    color.className = 'color';
    color.style.background = '#' + BLOCK_COLORS_SOLID[i].toString(16).padStart(6, '0');
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = i + ' ' + BLOCK_NAMES[i];
    slot.appendChild(color);
    slot.appendChild(label);
    bar.appendChild(slot);
  }
}

function updateHotbar() {
  const slots = document.querySelectorAll('.hotbar-slot');
  slots.forEach((s, i) => {
    s.classList.toggle('selected', i + 1 === selectedBlock);
  });
}
buildHotbar();

// ============================================================
// GAME LOOP
// ============================================================
const clock = new THREE.Clock();

function update(dt) {
  if (dt > 0.2) dt = 0.2; // clamp large dt (tab switch)

  // Mouse look
  camera.rotation.set(player.pitch, player.yaw, 0);

  // Movement direction
  const forward = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  const right   = new THREE.Vector3( Math.cos(player.yaw), 0, -Math.sin(player.yaw));

  const move = new THREE.Vector3();
  if (keys['KeyW']) move.add(forward);
  if (keys['KeyS']) move.add(forward.clone().negate());
  if (keys['KeyA']) move.add(right.clone().negate());
  if (keys['KeyD']) move.add(right);
  if (move.lengthSq() > 0) move.normalize();
  move.multiplyScalar(MOVE_SPEED * dt);

  // Gravity
  if (!player.onGround) {
    player.vel.y -= GRAVITY * dt;
  }

  // Jump
  if (player.onGround && keys['Space']) {
    player.vel.y = JUMP_SPEED;
    player.onGround = false;
  }

  // Integrate velocity
  const vMoveY = player.vel.y * dt;

  // Resolve X
  let nx = player.pos.x + move.x;
  if (checkCollision(nx, player.pos.y, player.pos.z)) {
    nx = player.pos.x;
  }

  // Resolve Y
  let ny = player.pos.y + vMoveY;
  if (checkCollision(nx, ny, player.pos.z)) {
    if (vMoveY < 0) {
      // Falling — push up to surface
      while (checkCollision(nx, ny, player.pos.z)) ny += 0.02;
      player.vel.y = 0;
    } else {
      // Rising — push down from ceiling
      while (checkCollision(nx, ny, player.pos.z)) ny -= 0.02;
      player.vel.y = 0;
    }
  }
  // On-ground probe: check block 0.05 below feet
  player.onGround = checkCollision(nx, ny - 0.05, player.pos.z);

  // Resolve Z
  let nz = player.pos.z + move.z;
  if (checkCollision(nx, ny, nz)) {
    nz = player.pos.z;
  }

  player.pos.set(nx, ny, nz);

  // Clamp to world
  player.pos.x = Math.max(PLAYER_W/2, Math.min(WORLD_SIZE - PLAYER_W/2, player.pos.x));
  player.pos.z = Math.max(PLAYER_W/2, Math.min(WORLD_SIZE - PLAYER_W/2, player.pos.z));
  if (player.pos.y < -10) player.pos.y = WORLD_HEIGHT; // respawn

  // Update camera
  camera.position.set(player.pos.x, player.pos.y + EYE_H, player.pos.z);

  // Highlight targeted block
  updateHighlight();

  // Update hotbar
  updateHotbar();
}

function updateHighlight() {
  const dir = getLookDir();
  const origin = new THREE.Vector3(player.pos.x, player.pos.y + EYE_H, player.pos.z);
  const hit = raycastVoxel(origin, dir, REACH);
  if (hit) {
    hlMesh.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    hlMesh.visible = true;
  } else {
    hlMesh.visible = false;
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (pointerLocked) update(dt);
  renderer.render(scene, camera);
}

// Handle resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Start
animate();
