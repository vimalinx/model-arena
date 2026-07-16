# Voxel Mini-Game

A playable Minecraft-like voxel world in the browser.

## How to Run

```bash
cd game/
python3 -m http.server 8000
```

Then open **http://localhost:8000** in your browser.

No `npm install` required — Three.js is loaded from CDN.

## Controls

| Key | Action |
|---|---|
| WASD | Move |
| Mouse | Look around |
| Space | Jump |
| Left Click | Break block |
| Right Click | Place block |
| 1–5 | Select block type |
| Esc | Release pointer lock |

## Block Types

1. **Grass** — green top, brown sides
2. **Dirt** — brown
3. **Stone** — gray
4. **Wood** — tan/brown
5. **Leaves** — dark green

## Technical

- Three.js via CDN (ES module import map)
- Voxel raycasting (Amanatides-Woo)
- Merged geometry with face culling
- First-person pointer lock controls
- AABB collision detection
