import { Container, Sprite, type BLEND_MODES, type Texture } from 'pixi.js';

/**
 * A grow-only pool of sprites inside one container.
 *
 * Usage per frame: begin(), then take() once per visible entity, then end()
 * to hide whatever was not claimed. Sprites are never created or destroyed
 * mid-frame — only reused and toggled — which keeps the render path as
 * allocation-free as the sim.
 *
 * take() accepts a per-entity texture so one layer can draw several enemy
 * types. Pixi batches multiple textures within a single draw call up to the
 * GPU's texture-unit limit, and four enemy silhouettes are comfortably inside
 * it, so this costs nothing versus a layer per type.
 */
export class SpriteLayer {
  readonly container = new Container();
  private readonly sprites: Sprite[] = [];
  private readonly texture: Texture;
  private readonly blendMode: BLEND_MODES;
  private cursor = 0;

  constructor(texture: Texture, initial = 64, blendMode: BLEND_MODES = 'normal') {
    this.texture = texture;
    this.blendMode = blendMode;
    // Batching wants a stable, homogeneous child list, so pre-warm it.
    for (let i = 0; i < initial; i++) this.sprites.push(this.create());
  }

  private create(): Sprite {
    const s = new Sprite(this.texture);
    s.anchor.set(0.5);
    s.visible = false;
    s.blendMode = this.blendMode;
    this.container.addChild(s);
    return s;
  }

  begin(): void {
    this.cursor = 0;
  }

  take(texture?: Texture): Sprite {
    let s = this.sprites[this.cursor];
    if (s === undefined) {
      s = this.create();
      this.sprites.push(s);
    }
    this.cursor++;
    s.visible = true;
    s.rotation = 0;
    s.alpha = 1;
    if (texture !== undefined && s.texture !== texture) s.texture = texture;
    return s;
  }

  end(): void {
    for (let i = this.cursor; i < this.sprites.length; i++) {
      const s = this.sprites[i]!;
      if (!s.visible) break; // everything past here was already hidden
      s.visible = false;
    }
  }
}
