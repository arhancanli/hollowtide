import { Pool } from '@arcade/core';
import { BitmapFont, BitmapText, Container } from 'pixi.js';

interface Floater {
  x: number;
  y: number;
  vx: number;
  life: number;
  maxLife: number;
  value: number;
  color: number;
  scale: number;
}

export interface FloatingTextOptions {
  fontName?: string;
  fontSize?: number;
  capacity?: number;
  /** Pixels risen over the floater's lifetime. */
  rise?: number;
  life?: number;
}

/**
 * Pooled damage numbers.
 *
 * Backed by a runtime-generated BitmapText font rather than plain Text. A
 * regular Text re-rasterises its texture every time `.text` changes, and these
 * change dozens of times a second — at swarm density that alone would cost more
 * than the entire simulation.
 */
export class FloatingText {
  readonly container = new Container();
  private readonly pool: Pool<Floater>;
  private readonly labels: BitmapText[] = [];
  private readonly rise: number;
  private readonly life: number;
  private seed = 0x1b873593;

  constructor(o: FloatingTextOptions = {}) {
    const fontName = o.fontName ?? 'juice-numeric';
    const fontSize = o.fontSize ?? 26;
    const capacity = o.capacity ?? 96;
    this.rise = o.rise ?? 30;
    this.life = o.life ?? 0.6;

    BitmapFont.install({
      name: fontName,
      style: {
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        fontSize,
        fontWeight: '800',
        fill: 0xffffff,
      },
      chars: '0123456789',
      resolution: 2,
    });

    this.pool = new Pool<Floater>(capacity, makeFloater, resetFloater);
    for (let i = 0; i < capacity; i++) {
      const label = new BitmapText({ text: '0', style: { fontFamily: fontName, fontSize } });
      label.anchor.set(0.5);
      label.visible = false;
      this.container.addChild(label);
      this.labels.push(label);
    }
  }

  private rand(): number {
    this.seed = (this.seed + 0x6d2b79f5) | 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  spawn(x: number, y: number, value: number, color = 0xffffff, scale = 1): void {
    const f = this.pool.spawn();
    if (!f) return;
    f.x = x + (this.rand() - 0.5) * 18;
    f.y = y;
    f.vx = (this.rand() - 0.5) * 22;
    f.maxLife = this.life;
    f.life = this.life;
    f.value = Math.max(1, Math.round(value));
    f.color = color;
    f.scale = scale;
  }

  update(dt: number): void {
    const list = this.pool.active;
    for (let i = list.length - 1; i >= 0; i--) {
      const f = list[i]!;
      f.life -= dt;
      if (f.life <= 0) this.pool.despawnAt(i);
      else f.x += f.vx * dt;
    }
  }

  render(): void {
    const list = this.pool.active;
    for (let i = 0; i < list.length; i++) {
      const f = list[i]!;
      const label = this.labels[i]!;
      const t = 1 - f.life / f.maxLife; // 0 at spawn, 1 at death
      const text = `${f.value}`;
      if (label.text !== text) label.text = text;
      label.visible = true;
      label.x = f.x;
      // Ease-out rise: fast off the impact, then settling.
      label.y = f.y - this.rise * (1 - (1 - t) * (1 - t));
      label.tint = f.color;
      // Scale pop 1.3 -> 1.0 over the first ~100ms, then hold.
      const pop = t < 0.17 ? 1.3 - 0.3 * (t / 0.17) : 1;
      label.scale.set(pop * f.scale);
      // Fade only over the last third.
      label.alpha = t > 0.66 ? 1 - (t - 0.66) / 0.34 : 1;
    }
    for (let i = list.length; i < this.labels.length; i++) {
      const label = this.labels[i]!;
      if (!label.visible) break;
      label.visible = false;
    }
  }

  clear(): void {
    this.pool.clear();
    for (const l of this.labels) l.visible = false;
  }
}

function makeFloater(): Floater {
  return { x: 0, y: 0, vx: 0, life: 0, maxLife: 1, value: 0, color: 0xffffff, scale: 1 };
}

function resetFloater(f: Floater): void {
  f.life = 0;
}
