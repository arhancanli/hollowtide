import { Container, Graphics } from 'pixi.js';
import { WEAPONS } from '../content/weapons.js';
import type { World } from '../sim/world.js';

/**
 * The loadout rail.
 *
 * The single biggest cause of "the game becomes too complicated": with six
 * weapons running, twenty-five facts exist about your build and ZERO of them
 * were ever displayed. Measured consequence — playing the way the cards read
 * ("always take the one marked NEW") reached an evolution in 0 of 30 runs,
 * while the same movement with knowledge the screen never shows reached one in
 * 23 of 30. The information wasn't hard to find; it was absent.
 *
 * Deliberately wordless and tiny (~2% of a 390x844 phone). One chip per slot in
 * acquisition order, so the rail's own length is the "slots left" signal.
 * A five-segment underline is the level. A ring around the chip carries
 * evolution state in one channel: absent = no evolution exists for this weapon,
 * dim = a path exists, gold = available right now.
 */
const CHIP_W = 34;
const CHIP_H = 30;
const GAP = 4;

export class LoadoutRail {
  readonly container = new Container();
  private readonly g = new Graphics();
  /** Redrawn only when the build actually changes, not every frame. */
  private signature = '';

  constructor() {
    this.container.addChild(this.g);
    this.container.eventMode = 'none';
  }

  resize(_width: number, _height: number): void {
    this.container.x = 12;
    this.container.y = 74;
  }

  setVisible(v: boolean): void {
    this.container.visible = v;
  }

  update(world: World): void {
    const p = world.player;
    // Signature includes evolution readiness, so the ring lights up the moment
    // the requirement is met rather than on the next level-up.
    let sig = '';
    for (const w of p.weapons) {
      const def = WEAPONS[w.id];
      const ready =
        def.evolvesInto && def.evolveWith
          ? w.level >= def.maxLevel && world.stacksOf(def.evolveWith) >= (def.evolveStacks ?? 1)
          : false;
      sig += `${w.id}${w.level}${ready ? 'R' : ''}|`;
    }
    if (sig === this.signature) return;
    this.signature = sig;

    const g = this.g;
    g.clear();

    for (let i = 0; i < p.weapons.length; i++) {
      const w = p.weapons[i]!;
      const def = WEAPONS[w.id];
      const x = i * (CHIP_W + GAP);

      g.roundRect(x, 0, CHIP_W, CHIP_H, 6).fill({ color: 0x0d1424, alpha: 0.62 });

      // The weapon's own colour is its identity — same hue it fires in.
      const inset = 7;
      g.roundRect(x + inset, inset, CHIP_W - inset * 2, CHIP_H - inset * 2 - 4, 3).fill({
        color: def.color,
        alpha: def.evolved ? 1 : 0.85,
      });

      // Level: five segments, filled to level. Evolved forms level too now, so
      // they get the same read — a solid bar would have said "finished" about a
      // weapon that still has four levels left in it.
      const barY = CHIP_H - 5;
      const barW = CHIP_W - 12;
      const seg = (barW - 4 * 1) / 5;
      for (let s = 0; s < 5; s++) {
        g.rect(x + 6 + s * (seg + 1), barY, seg, 2).fill({
          color: s < w.level ? def.color : 0x2b3a5c,
        });
      }

      // Evolution state, one ring, three states.
      if (def.evolvesInto && def.evolveWith) {
        const need = def.evolveStacks ?? 1;
        const ready = w.level >= def.maxLevel && world.stacksOf(def.evolveWith) >= need;
        const half = w.level >= def.maxLevel || world.stacksOf(def.evolveWith) >= need;
        g.roundRect(x + 0.75, 0.75, CHIP_W - 1.5, CHIP_H - 1.5, 6).stroke({
          width: 1.5,
          color: ready ? 0xffd23a : 0xffffff,
          alpha: ready ? 1 : half ? 0.42 : 0.12,
        });
      }
    }
  }
}
