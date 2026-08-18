import { Pool } from '@arcade/core';
import { Container, Sprite, type Texture } from 'pixi.js';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  endSize: number;
  color: number;
  drag: number;
  gravity: number;
  spin: number;
  rotation: number;
}

export interface BurstOptions {
  count: number;
  color: number;
  speed: number;
  speedVariance: number;
  life: number;
  size: number;
  endSize?: number;
  gravity?: number;
  drag?: number;
  spread?: number;
  /** Direction to bias the burst toward, radians. Omit for a full circle. */
  direction?: number;
}

/**
 * Pooled sprite particles.
 *
 * Fixed capacity and no allocation at runtime, same discipline as the sim. A
 * burst that would exceed capacity is silently truncated rather than growing
 * the pool — dropping a few sparks is invisible, a mid-combat GC pause is not.
 */
export class Particles {
  readonly container = new Container();
  private readonly pool: Pool<Particle>;
  private readonly sprites: Sprite[] = [];
  private readonly texture: Texture;
  private seed = 0x9e3779b9;

  constructor(texture: Texture, capacity = 600) {
    this.texture = texture;
    this.pool = new Pool<Particle>(capacity, makeParticle, resetParticle);
    for (let i = 0; i < capacity; i++) {
      const s = new Sprite(this.texture);
      s.anchor.set(0.5);
      s.visible = false;
      this.container.addChild(s);
      this.sprites.push(s);
    }
  }

  /** Local PRNG so particle scatter never touches the sim's stream. */
  private rand(): number {
    this.seed = (this.seed + 0x6d2b79f5) | 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  burst(x: number, y: number, o: BurstOptions): void {
    const spread = o.spread ?? Math.PI * 2;
    /**
     * Thin the burst instead of truncating it.
     *
     * This asked for its full count and bailed on the first failed spawn, so
     * once the pool saturated — measured from ~2:15 in every build, and pinned
     * at 640-696 of 700 for the rest of the run — bursts were cut off at
     * whatever point they happened to run out. One session dropped 394,917 of
     * 667,331 particles, 59.2%. The visible result is that some kills flash and
     * some do not, at random, which reads as the game glitching.
     *
     * Scaling by headroom degrades every burst equally and smoothly: at 50%
     * full each kill still sparks, just with fewer motes. That is a look. A
     * kill with no spark at all is a bug.
     */
    let count = o.count;
    const headroom = 1 - this.pool.count / this.pool.capacity;
    if (headroom < 0.5) count = Math.max(1, Math.round(o.count * headroom * 2));
    for (let i = 0; i < count; i++) {
      const p = this.pool.spawn();
      if (!p) return;
      const a =
        o.direction === undefined
          ? this.rand() * Math.PI * 2
          : o.direction + (this.rand() - 0.5) * spread;
      const speed = o.speed + (this.rand() - 0.5) * 2 * o.speedVariance;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * speed;
      p.vy = Math.sin(a) * speed;
      p.maxLife = o.life * (0.75 + this.rand() * 0.5);
      p.life = p.maxLife;
      p.size = o.size;
      p.endSize = o.endSize ?? 0;
      p.color = o.color;
      p.gravity = o.gravity ?? 0;
      p.drag = o.drag ?? 2.5;
      p.spin = (this.rand() - 0.5) * 12;
      p.rotation = this.rand() * Math.PI * 2;
    }
  }

  update(dt: number): void {
    const list = this.pool.active;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        this.pool.despawnAt(i);
        continue;
      }
      const decay = Math.exp(-p.drag * dt);
      p.vx *= decay;
      p.vy = p.vy * decay + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.spin * dt;
    }
  }

  render(): void {
    const list = this.pool.active;
    for (let i = 0; i < list.length; i++) {
      const p = list[i]!;
      const s = this.sprites[i]!;
      const f = p.life / p.maxLife;
      const size = p.endSize + (p.size - p.endSize) * f;
      s.visible = true;
      s.x = p.x;
      s.y = p.y;
      s.width = size;
      s.height = size;
      s.rotation = p.rotation;
      s.tint = p.color;
      // Fade only over the last 40% so particles stay punchy, then vanish.
      s.alpha = f > 0.4 ? 1 : f / 0.4;
    }
    for (let i = list.length; i < this.sprites.length; i++) {
      const s = this.sprites[i]!;
      if (!s.visible) break;
      s.visible = false;
    }
  }

  clear(): void {
    this.pool.clear();
    for (const s of this.sprites) s.visible = false;
  }
}

function makeParticle(): Particle {
  return {
    x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1,
    size: 1, endSize: 0, color: 0xffffff, drag: 0, gravity: 0, spin: 0, rotation: 0,
  };
}

function resetParticle(p: Particle): void {
  p.life = 0;
  p.vx = 0;
  p.vy = 0;
}
