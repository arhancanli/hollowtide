import { Pool } from '@arcade/core';
import { Container, Graphics, type Texture } from 'pixi.js';

interface Wave {
  x: number;
  y: number;
  life: number;
  maxLife: number;
  from: number;
  to: number;
  color: number;
  alpha: number;
}

/**
 * Expanding rings. Used for level-ups, elite deaths and revives — moments that
 * need to read as significant from the corner of the eye, without the player
 * having to look away from what is chasing them.
 */
export class Shockwaves {
  readonly container = new Container();
  private readonly pool: Pool<Wave>;
  /**
   * Drawn, not scaled.
   *
   * These were sprites of a ring texture whose stroke was 16% of its own width,
   * scaled up to the blast radius — so the stroke scaled with the radius. A
   * SUPERNOVA blast at max +REACH measured 1717px across with a 137px stroke on
   * a 430px viewport: not a ring, an opaque band sweeping a third of the screen,
   * several at a time. A ring has to read as a ring at every size, which means
   * the stroke width cannot be a function of the radius.
   */
  private readonly g = new Graphics();

  constructor(_ringTexture: Texture, capacity = 24) {
    this.pool = new Pool<Wave>(capacity, makeWave, resetWave);
    this.container.addChild(this.g);
  }

  /**
   * @param important Ring the player MUST see — a boss telegraph, a revive.
   *   The pool saturates at 24 from ~3:05 onward and was dropping 13-20 rings a
   *   second, which included the `bossSpawned` warning: a boss could arrive
   *   with no telegraph at all, purely because a dozen blasts got there first.
   *   An important ring evicts the oldest ordinary one instead of being lost.
   */
  spawn(
    x: number,
    y: number,
    from: number,
    to: number,
    life: number,
    color: number,
    alpha = 1,
    important = false,
  ): void {
    if (important && this.pool.count >= this.pool.capacity) {
      const list = this.pool.active;
      let oldest = 0;
      for (let i = 1; i < list.length; i++) {
        if (list[i]!.life < list[oldest]!.life) oldest = i;
      }
      this.pool.despawnAt(oldest);
    }
    const w = this.pool.spawn();
    if (!w) return;
    w.x = x;
    w.y = y;
    w.from = from;
    w.to = to;
    w.maxLife = life;
    w.life = life;
    w.color = color;
    w.alpha = alpha;
  }

  update(dt: number): void {
    const list = this.pool.active;
    for (let i = list.length - 1; i >= 0; i--) {
      const w = list[i]!;
      w.life -= dt;
      if (w.life <= 0) this.pool.despawnAt(i);
    }
  }

  render(): void {
    const g = this.g;
    g.clear();
    const list = this.pool.active;
    for (let i = 0; i < list.length; i++) {
      const w = list[i]!;
      const t = 1 - w.life / w.maxLife;
      // Ease-out expansion: the ring leaps outward then decelerates, which
      // reads as a release of energy rather than a growing circle.
      const eased = 1 - (1 - t) * (1 - t) * (1 - t);
      const radius = (w.from + (w.to - w.from) * eased) * 0.5;
      if (radius <= 1) continue;
      // Constant in screen terms, with a gentle nod to scale so a big blast
      // still reads as heavier than a small one — but sub-linearly, so it can
      // never become a band.
      const width = Math.min(9, 2.5 + Math.sqrt(radius) * 0.22);
      g.circle(w.x, w.y, radius).stroke({
        width,
        color: w.color,
        alpha: w.alpha * (1 - t),
      });
    }
  }

  clear(): void {
    this.pool.clear();
    this.g.clear();
  }
}

function makeWave(): Wave {
  return { x: 0, y: 0, life: 0, maxLife: 1, from: 0, to: 1, color: 0xffffff, alpha: 1 };
}

function resetWave(w: Wave): void {
  w.life = 0;
}
