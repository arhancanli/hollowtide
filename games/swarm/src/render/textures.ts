import { Texture, type Renderer } from 'pixi.js';

/**
 * All art, generated with canvas2D at boot.
 *
 * No image files anywhere in the project. Same reasoning as the audio: art is
 * usually the bulk of a portal build, and load-to-playable is what decides
 * whether anyone sees it. This costs zero bytes and stays crisp at any DPR.
 *
 * Textures are drawn in WHITE and greyscale and coloured at runtime by tint,
 * which multiplies — so the luminance shaping baked in here (bright core, dark
 * rim, lit from above) survives tinting and every entity gets form rather than
 * reading as a flat disc.
 *
 * Each enemy type has a distinct SILHOUETTE, not just a distinct colour. At
 * swarm density colour alone is unreadable, and it fails outright for the ~8%
 * of players with a colour vision deficiency.
 */
export interface ArtTextures {
  glow: Texture;
  vignette: Texture;
  player: Texture;
  drifter: Texture;
  elite: Texture;
  herald: Texture;
  /** Points along +X so it can be rotated to face its heading. */
  stalker: Texture;
  splitter: Texture;
  lantern: Texture;
  bomber: Texture;
  warden: Texture;
  /** Points along +X, like the stalker — its charge must be readable. */
  lancer: Texture;
  brood: Texture;
  colossus: Texture;
  harbinger: Texture;
  bulwark: Texture;
  weaver: Texture;
  burrower: Texture;
  gem: Texture;
  bolt: Texture;
  ring: Texture;
  spark: Texture;
  disc: Texture;
  grid: Texture;
  /** Textured terrain tile — the world is a place, not a void. */
  ground: Texture;
  /** Sparse surface detail scattered over the terrain. */
  detail: Texture;
}

function canvasTexture(
  size: number,
  draw: (ctx: CanvasRenderingContext2D, s: number) => void,
): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx, size);
  return Texture.from(canvas);
}

/**
 * Soft contact shadow, baked into the creature texture itself.
 *
 * Nothing in the old build cast a shadow, so every entity floated in front of
 * the background rather than standing on it — a large part of why the game read
 * as a debug view next to the CrazyGames shelf. Baking it costs zero extra
 * sprites and zero fill rate versus a separate shadow layer.
 *
 * Drawn in near-black rather than pure black so it darkens the terrain instead
 * of punching a hole in it.
 */
function contactShadow(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.22)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, 0.42);
  ctx.translate(-cx, -cy);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Two eyes. The cheapest way to turn a shape into a creature. */
function eyes(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, spread = 0.42): void {
  const er = r * 0.2;
  for (const side of [-1, 1]) {
    ctx.fillStyle = 'rgba(10,10,14,0.92)';
    ctx.beginPath();
    ctx.arc(cx + side * r * spread, cy, er, 0, Math.PI * 2);
    ctx.fill();
    // A single highlight reads as wet and alive rather than as a hole.
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(cx + side * r * spread - er * 0.3, cy - er * 0.35, er * 0.34, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Lit-from-above body shading, reused by every round enemy. */
function shadedBody(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.5, '#dedede');
  // Rim lifted from #6c6c6c: tint multiplies, so a dark rim was desaturating
  // every creature into the background instead of shaping it.
  grad.addColorStop(1, '#9a9a9a');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

export function createTextures(renderer: Renderer): ArtTextures {
  void renderer;
  const S = 128;
  const C = S / 2;

  const glow = canvasTexture(S, (ctx, s) => {
    const c = s / 2;
    const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
    // A steep falloff. A linear one reads as fog rather than light.
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.18, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.14)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);
  });

  // Darkens the screen edges. Restrained depth — it pulls the eye to the
  // player without hiding anything the player has to read.
  const vignette = canvasTexture(256, (ctx, s) => {
    const c = s / 2;
    const grad = ctx.createRadialGradient(c, c, c * 0.45, c, c, c * 0.95);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);
  });

  const player = canvasTexture(S, (ctx) => {
    contactShadow(ctx, C, C + C * 0.62, C * 0.6);
    shadedBody(ctx, C, C, C * 0.62);
    // Bright rim so the silhouette survives being surrounded.
    ctx.lineWidth = C * 0.13;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(C, C, C * 0.68, 0, Math.PI * 2);
    ctx.stroke();
  });

  const drifter = canvasTexture(S, (ctx) => {
    contactShadow(ctx, C, C + C * 0.68, C * 0.72);
    shadedBody(ctx, C, C, C * 0.74);
    ctx.lineWidth = C * 0.08;
    ctx.strokeStyle = 'rgba(30,30,36,0.9)';
    ctx.beginPath();
    ctx.arc(C, C, C * 0.74, 0, Math.PI * 2);
    ctx.stroke();
    eyes(ctx, C, C - C * 0.08, C * 0.74);
  });

  // Armour plates around a heavy core: reads as "this one takes work".
  const elite = canvasTexture(S, (ctx) => {
    contactShadow(ctx, C, C + C * 0.78, C * 0.8);
    const r = C * 0.6;
    ctx.lineWidth = C * 0.16;
    ctx.strokeStyle = '#ffffff';
    for (let i = 0; i < 6; i++) {
      const a0 = (i / 6) * Math.PI * 2 + 0.18;
      const a1 = ((i + 1) / 6) * Math.PI * 2 - 0.18;
      ctx.beginPath();
      ctx.arc(C, C, C * 0.86, a0, a1);
      ctx.stroke();
    }
    shadedBody(ctx, C, C, r);
    ctx.lineWidth = C * 0.07;
    ctx.strokeStyle = 'rgba(30,30,30,0.8)';
    ctx.beginPath();
    ctx.arc(C, C, r, 0, Math.PI * 2);
    ctx.stroke();
    eyes(ctx, C, C - C * 0.06, r, 0.38);
  });

  // Angular hexagon — clearly not one of the round rank-and-file.
  const herald = canvasTexture(S, (ctx) => {
    const r = C * 0.8;
    const grad = ctx.createLinearGradient(0, C - r, 0, C + r);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#7d7d7d');
    ctx.fillStyle = grad;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      const x = C + Math.cos(a) * r;
      const y = C + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = C * 0.09;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  });

  // A dart, pointing +X. Rotated to its heading in view.ts so the one enemy
  // that can actually catch you visibly aims at you.
  const stalker = canvasTexture(S, (ctx) => {
    const grad = ctx.createLinearGradient(C * 0.2, 0, C * 1.9, 0);
    grad.addColorStop(0, '#6a6a6a');
    grad.addColorStop(1, '#ffffff');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(C * 1.92, C);
    ctx.lineTo(C * 0.55, C * 0.42);
    ctx.lineTo(C * 0.78, C);
    ctx.lineTo(C * 0.55, C * 1.58);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = C * 0.07;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  });

  // Visibly already divided, so "killing it makes two" reads before it happens.
  const splitter = canvasTexture(S, (ctx) => {
    contactShadow(ctx, C, C + C * 0.7, C * 0.72);
    shadedBody(ctx, C, C, C * 0.78);
    ctx.lineWidth = C * 0.12;
    ctx.strokeStyle = 'rgba(20,20,20,0.9)';
    ctx.beginPath();
    ctx.moveTo(C, C - C * 0.78);
    ctx.lineTo(C, C + C * 0.78);
    ctx.stroke();
    ctx.lineWidth = C * 0.08;
    ctx.strokeStyle = 'rgba(40,40,40,0.85)';
    ctx.beginPath();
    ctx.arc(C, C, C * 0.78, 0, Math.PI * 2);
    ctx.stroke();
  });

  // A hollow ring around a bright core: reads as "this one shoots" and stays
  // findable at the edge of the screen where it lives.
  const lantern = canvasTexture(S, (ctx) => {
    contactShadow(ctx, C, C + C * 0.78, C * 0.72);
    ctx.lineWidth = C * 0.16;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(C, C, C * 0.8, 0, Math.PI * 2);
    ctx.stroke();
    const grad = ctx.createRadialGradient(C, C, 0, C, C, C * 0.5);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, 'rgba(255,255,255,0.25)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(C, C, C * 0.42, 0, Math.PI * 2);
    ctx.fill();
  });

  // Spiked, because it detonates and the player needs a reason not to hug it.
  const bomber = canvasTexture(S, (ctx) => {
    contactShadow(ctx, C, C + C * 0.8, C * 0.74);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const r = i % 2 === 0 ? C * 0.92 : C * 0.6;
      const x = C + Math.cos(a) * r;
      const y = C + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    shadedBody(ctx, C, C, C * 0.55);
    // A hot core — this one is about to go off.
    const core = ctx.createRadialGradient(C, C, 0, C, C, C * 0.34);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(C, C, C * 0.34, 0, Math.PI * 2);
    ctx.fill();
  });


  // ---- the late roster ---------------------------------------------------
  //
  // Each silhouette states its rule before any tooltip does: BULWARK is a slab
  // behind a shield, WEAVER is a spindly thing trailing filaments, BURROWER is
  // a wedge that reads as half-buried. A player should be able to guess wrong
  // once and never again.
  const bulwark = canvasTexture(S, (ctx) => {
    contactShadow(ctx, C, C + C * 0.82, C * 0.86);
    // Squat hexagonal slab — wide, low, immovable.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const x = C + Math.cos(a) * C * 0.9;
      const y = C + Math.sin(a) * C * 0.72;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    shadedBody(ctx, C, C, C * 0.58);
    // Plating: three bands across the face, the read for "armoured".
    ctx.strokeStyle = 'rgba(20,22,30,0.5)';
    ctx.lineWidth = C * 0.09;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(C - C * 0.62, C + i * C * 0.3);
      ctx.lineTo(C + C * 0.62, C + i * C * 0.3);
      ctx.stroke();
    }
    eyes(ctx, C, C - C * 0.06, C * 0.5, 0.36);
  });

  const weaver = canvasTexture(S, (ctx) => {
    contactShadow(ctx, C, C + C * 0.78, C * 0.6);
    // Filaments first, so the body sits on top of them.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = C * 0.05;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.4;
      ctx.beginPath();
      ctx.moveTo(C, C);
      ctx.quadraticCurveTo(
        C + Math.cos(a) * C * 0.55,
        C + Math.sin(a) * C * 0.55 - C * 0.2,
        C + Math.cos(a) * C * 0.95,
        C + Math.sin(a) * C * 0.95,
      );
      ctx.stroke();
    }
    shadedBody(ctx, C, C, C * 0.46);
    // A bright node — the thing to shoot.
    const core = ctx.createRadialGradient(C, C, 0, C, C, C * 0.3);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(C, C, C * 0.3, 0, Math.PI * 2);
    ctx.fill();
    eyes(ctx, C, C, C * 0.4, 0.34);
  });

  const burrower = canvasTexture(S, (ctx) => {
    contactShadow(ctx, C, C + C * 0.8, C * 0.7);
    // A forward wedge: it reads as something that arrives point-first.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(C, C - C * 0.92);
    ctx.lineTo(C + C * 0.78, C + C * 0.5);
    ctx.lineTo(C, C + C * 0.86);
    ctx.lineTo(C - C * 0.78, C + C * 0.5);
    ctx.closePath();
    ctx.fill();
    shadedBody(ctx, C, C + C * 0.06, C * 0.5);
    // Claw ridges either side of the head.
    ctx.strokeStyle = 'rgba(20,22,30,0.42)';
    ctx.lineWidth = C * 0.08;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(C + side * C * 0.2, C - C * 0.5);
      ctx.lineTo(C + side * C * 0.52, C + C * 0.12);
      ctx.stroke();
    }
    eyes(ctx, C, C + C * 0.16, C * 0.42, 0.38);
  });

  const colossus = canvasTexture(S, (ctx) => {
    contactShadow(ctx, C, C + C * 0.86, C * 0.96);
    ctx.lineWidth = C * 0.12;
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    // Broad octagonal bulk with a heavy outline: mass, not speed.
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const x = C + Math.cos(a) * C * 0.94;
      const y = C + Math.sin(a) * C * 0.84;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    shadedBody(ctx, C, C, C * 0.62);
    // Fists — the parts that hit the ground.
    for (const side of [-1, 1]) {
      shadedBody(ctx, C + side * C * 0.7, C + C * 0.46, C * 0.26);
    }
    eyes(ctx, C, C - C * 0.12, C * 0.54, 0.34);
  });

  const harbinger = canvasTexture(S, (ctx) => {
    contactShadow(ctx, C, C + C * 0.8, C * 0.72);
    // Diamond core inside an open ring: reads as "it emits things".
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = C * 0.09;
    ctx.beginPath();
    ctx.arc(C, C, C * 0.86, 0.5, Math.PI * 2 - 0.5);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(C, C - C * 0.72);
    ctx.lineTo(C + C * 0.58, C);
    ctx.lineTo(C, C + C * 0.72);
    ctx.lineTo(C - C * 0.58, C);
    ctx.closePath();
    ctx.fill();
    shadedBody(ctx, C, C, C * 0.44);
    eyes(ctx, C, C, C * 0.4, 0.3);
  });

  // Bosses: heavier, plated versions of the language already established, so
  // they read as "the big one" instantly rather than as an unrelated sprite.
  const warden = canvasTexture(S, (ctx) => {
    contactShadow(ctx, C, C + C * 0.84, C * 0.9);
    ctx.lineWidth = C * 0.13;
    ctx.strokeStyle = '#ffffff';
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * Math.PI * 2 + 0.12;
      const a1 = ((i + 1) / 8) * Math.PI * 2 - 0.12;
      ctx.beginPath();
      ctx.arc(C, C, C * 0.9, a0, a1);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(C, C, C * 0.74, a0, a1);
      ctx.stroke();
    }
    shadedBody(ctx, C, C, C * 0.58);
    eyes(ctx, C, C - C * 0.04, C * 0.58, 0.4);
  });

  const lancer = canvasTexture(S, (ctx) => {
    const grad = ctx.createLinearGradient(C * 0.2, 0, C * 1.95, 0);
    grad.addColorStop(0, '#5c5c5c');
    grad.addColorStop(1, '#ffffff');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(C * 1.95, C);
    ctx.lineTo(C * 0.42, C * 0.3);
    ctx.lineTo(C * 0.72, C);
    ctx.lineTo(C * 0.42, C * 1.7);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = C * 0.09;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  });

  const brood = canvasTexture(S, (ctx) => {
    contactShadow(ctx, C, C + C * 0.9, C * 0.95);
    shadedBody(ctx, C, C, C * 0.9);
    // Visible cells: it is full of the things it bursts into.
    ctx.fillStyle = 'rgba(25,25,25,0.75)';
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const r = C * 0.46;
      ctx.beginPath();
      ctx.arc(C + Math.cos(a) * r, C + Math.sin(a) * r, C * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(C, C, C * 0.18, 0, Math.PI * 2);
    ctx.fill();
  });

  const gem = canvasTexture(S, (ctx) => {
    const w = C * 0.52;
    const h = C * 0.82;
    // Top facet bright, bottom facet dark — reads as a cut stone, not a square.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(C, C - h);
    ctx.lineTo(C + w, C);
    ctx.lineTo(C, C);
    ctx.lineTo(C - w, C);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#8a8a8a';
    ctx.beginPath();
    ctx.moveTo(C - w, C);
    ctx.lineTo(C, C);
    ctx.lineTo(C + w, C);
    ctx.lineTo(C, C + h);
    ctx.closePath();
    ctx.fill();
  });

  const bolt = canvasTexture(S, (ctx, s) => {
    const grad = ctx.createLinearGradient(0, C, s, C);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.75, '#ffffff');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    const h = C * 0.26;
    ctx.beginPath();
    ctx.ellipse(C, C, C * 0.95, h, 0, 0, Math.PI * 2);
    ctx.fill();
  });

  const ring = canvasTexture(S, (ctx) => {
    ctx.lineWidth = C * 0.16;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(C, C, C * 0.76, 0, Math.PI * 2);
    ctx.stroke();
  });

  const spark = canvasTexture(64, (ctx, s) => {
    const c = s / 2;
    const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);
  });

  const disc = canvasTexture(64, (ctx, s) => {
    const c = s / 2;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(c, c, c * 0.92, 0, Math.PI * 2);
    ctx.fill();
  });

  /**
   * The ground.
   *
   * The single biggest reason this game read as "basic" next to the CrazyGames
   * shelf: competitors put the fight on textured terrain, and we put it in a
   * black void with a faint grid — which reads as a debug view rather than a
   * place. This is a 256px tile with base earth, low-frequency blotching, fine
   * speckle and a few flecks, drawn in greyscale so it can be tinted.
   */
  const ground = canvasTexture(256, (ctx, s) => {
    // Deterministic noise so the tile is identical every session.
    let seed = 0x51ed270b;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // Near-white base: Pixi tint MULTIPLIES, so the tint can only ever darken.
    // A mid-grey base meant the terrain tint rendered at RGB(23,23,28) — black.
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(0, 0, s, s);

    // Low-frequency blotches give the terrain large-scale variation, so tiling
    // does not read as a repeating stamp at speed.
    for (let i = 0; i < 26; i++) {
      const r = 26 + rand() * 74;
      const g = ctx.createRadialGradient(rand() * s, rand() * s, 0, rand() * s, rand() * s, r);
      const light = rand() > 0.5;
      g.addColorStop(0, light ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.13)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }

    // Fine speckle: the difference between "a surface" and "a flat fill".
    for (let i = 0; i < 2600; i++) {
      const a = rand();
      ctx.fillStyle = a > 0.5 ? `rgba(255,255,255,${0.05 + rand() * 0.07})` : `rgba(0,0,0,${0.05 + rand() * 0.09})`;
      ctx.fillRect(rand() * s, rand() * s, 1, 1 + (rand() > 0.85 ? 1 : 0));
    }

    // A few brighter flecks catch the eye and sell scale as you move over them.
    for (let i = 0; i < 34; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.10 + rand() * 0.13})`;
      const w = 1 + rand() * 2.4;
      ctx.fillRect(rand() * s, rand() * s, w, w * 0.7);
    }
  });

  // Scattered surface detail — sparse, so it reads as terrain rather than noise.
  const detail = canvasTexture(64, (ctx, s) => {
    const c = s / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c - 12, c + 4);
    ctx.quadraticCurveTo(c - 2, c - 8, c + 6, c + 2);
    ctx.quadraticCurveTo(c + 12, c + 7, c + 15, c - 2);
    ctx.stroke();
  });

  // The field is unbounded, so without a static reference the player cannot
  // tell they are moving — the swarm just appears to slide around them.
  const grid = canvasTexture(64, (ctx, s) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, s, 1);
    ctx.fillRect(0, 0, 1, s);
  });

  return {
    glow, vignette, player, drifter, elite, herald, stalker, splitter, bomber, lantern,
    warden, lancer, brood, colossus, harbinger, bulwark, weaver, burrower,
    gem, bolt, ring, spark, disc, grid, ground, detail,
  };
}
