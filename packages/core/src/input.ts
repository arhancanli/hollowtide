import { dhypot } from './detmath.js';
/**
 * Movement input: floating touch joystick (primary) + WASD/arrows (desktop dev).
 *
 * Mobile-first on purpose. Most portal traffic is mobile web, so the thumb is
 * the real control scheme and the keyboard is the adaptation, not the reverse.
 *
 * The joystick spawns wherever the thumb lands rather than sitting in a fixed
 * corner — fixed sticks force players to look away from the action to find
 * them, and on a phone the eyes must stay on the character.
 */
const DEAD_ZONE = 0.18;

/** Longest press still counted as a tap rather than a grab, in milliseconds. */
const TAP_MS = 180;
/** Furthest a tap may travel, in CSS pixels. */
const TAP_SLOP = 14;

export class InputController {
  /** Normalised movement direction. Length is 0 or 1, never in between. */
  readonly dir = { x: 0, y: 0 };

  /** Raw stick deflection 0..1, for drawing the knob. */
  magnitude = 0;

  /** Touch origin in CSS pixels, or null when the stick is not engaged. */
  origin: { x: number; y: number } | null = null;
  knob: { x: number; y: number } | null = null;

  /** Fires once, on the very first real input. Unlocks audio + funnel event. */
  onFirstInput: (() => void) | null = null;
  /**
   * The ability trigger.
   *
   * Fires on a SECOND simultaneous touch anywhere on the canvas, on a tap
   * inside the on-screen button, and on Space/Shift.
   *
   * The second-touch rule matters more than it looks. The stick spawns wherever
   * the first thumb lands, so a two-handed player is already holding one finger
   * down when they need the ability — requiring them to find a fixed button
   * with that same thumb means letting go of steering at the exact moment they
   * are being surrounded, which is when the ability exists to be used.
   */
  onAbility: (() => void) | null = null;

  /**
   * A quick TAP on the steering thumb also fires the ability.
   *
   * The on-screen button and the second-finger gesture both assume two hands.
   * A one-handed player is holding the stick with the only thumb they have, so
   * using the ability means letting go of steering — at exactly the moment they
   * are being surrounded, which is the moment the ability exists for. A short
   * press-and-release that barely moves is unambiguous: nobody steers by
   * tapping, because a tap produces no sustained direction.
   *
   * Guarded three ways so a genuine grab is never mistaken for a tap: it must
   * be brief, it must barely travel, and the stick must already have been held
   * once this run — so the very first touch of a session always steers.
   */
  private pressAt = 0;
  private pressX = 0;
  private pressY = 0;
  private hasSteered = false;

  /**
   * Gate the stick while an overlay owns the screen. Without this, the tap
   * that picks an upgrade card also grabs the joystick, and the player walks
   * off in a random direction the instant play resumes.
   */
  private enabled = true;

  private firstInputFired = false;
  private pointerId = -1;
  private readonly keys = new Set<string>();
  private readonly radius: number;
  private readonly el: HTMLElement;
  private attached = false;

  constructor(el: HTMLElement, radius = 60) {
    this.el = el;
    this.radius = radius;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.el.addEventListener('pointerdown', this.onPointerDown);
    this.el.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.el.removeEventListener('pointerdown', this.onPointerDown);
    this.el.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  /** Last known pointer position, tracked even while disabled. */
  private lastX = 0;
  private lastY = 0;

  /**
   * Enable/disable the stick.
   *
   * CRITICAL: disabling must NOT forget the active pointer.
   *
   * It used to call release(), which set pointerId = -1. Every level-up
   * disables the stick, so a player holding their thumb down through a card
   * pick came back to a dead joystick: pointermove early-returned on the id
   * mismatch, and pointerdown never fired again because the finger had never
   * lifted. Movement was gone until they released and re-pressed — after every
   * single level-up, in a game where standing still is death. The bottom-
   * anchored card layout actively encourages keeping the steering thumb down.
   *
   * On re-enable the stick re-centres under wherever the thumb currently is,
   * which is also the correct feel: the origin follows the hand.
   */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.dir.x = 0;
      this.dir.y = 0;
      this.magnitude = 0;
      this.keys.clear();
      return;
    }
    if (this.pointerId !== -1) {
      this.origin = { x: this.lastX, y: this.lastY };
      this.knob = { x: this.lastX, y: this.lastY };
      this.recompute(this.lastX, this.lastY);
    }
  }

  /** Suspend stick + keys, e.g. while an upgrade card overlay is open. */
  release(): void {
    this.pointerId = -1;
    this.origin = null;
    this.knob = null;
    this.magnitude = 0;
    this.dir.x = 0;
    this.dir.y = 0;
    this.keys.clear();
  }

  private fireFirstInput(): void {
    if (this.firstInputFired) return;
    this.firstInputFired = true;
    this.onFirstInput?.();
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.pointerId !== -1) {
      // A second finger while the stick is held is the ability, never a second
      // stick. Steering is unaffected — the first pointer keeps ownership.
      if (this.enabled) this.onAbility?.();
      return;
    }
    if (!this.enabled) {
      // Still claim the pointer. Otherwise a press that lands during a card
      // draw is invisible forever and the stick is dead on resume.
      this.pointerId = e.pointerId;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      return;
    }
    this.pointerId = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.origin = { x: e.clientX, y: e.clientY };
    this.knob = { x: e.clientX, y: e.clientY };
    this.pressAt = e.timeStamp;
    this.pressX = e.clientX;
    this.pressY = e.clientY;
    this.fireFirstInput();
    this.recompute(e.clientX, e.clientY);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    // Position is recorded even while disabled, so re-enabling can pick the
    // stick back up under a thumb that never lifted.
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (!this.enabled || !this.origin) return;
    // Any real steering travel marks the stick as used, which arms the tap
    // gesture. Before that, the first touch of a session is always movement.
    if (!this.hasSteered && dhypot(e.clientX - this.pressX, e.clientY - this.pressY) > TAP_SLOP) {
      this.hasSteered = true;
    }
    this.recompute(e.clientX, e.clientY);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    if (this.enabled && this.hasSteered) {
      const held = e.timeStamp - this.pressAt;
      const moved = dhypot(e.clientX - this.pressX, e.clientY - this.pressY);
      if (held <= TAP_MS && moved <= TAP_SLOP) this.onAbility?.();
    }
    this.pointerId = -1;
    this.origin = null;
    this.knob = null;
    this.magnitude = 0;
    if (this.keys.size === 0) {
      this.dir.x = 0;
      this.dir.y = 0;
    }
  };

  private recompute(cx: number, cy: number): void {
    const o = this.origin;
    if (!o) return;

    let dx = cx - o.x;
    let dy = cy - o.y;
    const dist = dhypot(dx, dy);

    // Drag beyond the ring and the ring follows, so the stick can never run
    // out of travel mid-panic. This is the single biggest feel win on mobile.
    if (dist > this.radius) {
      const pull = (dist - this.radius) / dist;
      o.x += dx * pull;
      o.y += dy * pull;
      dx = cx - o.x;
      dy = cy - o.y;
    }

    this.knob = { x: cx, y: cy };

    const len = dhypot(dx, dy);
    const norm = Math.min(len / this.radius, 1);
    if (norm < DEAD_ZONE) {
      this.magnitude = 0;
      this.dir.x = 0;
      this.dir.y = 0;
      return;
    }
    this.magnitude = norm;
    this.dir.x = dx / len;
    this.dir.y = dy / len;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      if (this.enabled) {
        e.preventDefault();
        this.fireFirstInput();
        this.onAbility?.();
      }
      return;
    }
    if (!this.enabled || e.repeat) return;
    this.keys.add(e.key.toLowerCase());
    this.applyKeys();
    if (this.dir.x !== 0 || this.dir.y !== 0) this.fireFirstInput();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
    this.applyKeys();
  };

  private onBlur = (): void => {
    this.release();
  };

  private applyKeys(): void {
    if (this.origin) return; // touch wins while engaged
    const k = this.keys;
    let x = 0;
    let y = 0;
    if (k.has('a') || k.has('arrowleft')) x -= 1;
    if (k.has('d') || k.has('arrowright')) x += 1;
    if (k.has('w') || k.has('arrowup')) y -= 1;
    if (k.has('s') || k.has('arrowdown')) y += 1;
    const len = dhypot(x, y);
    if (len === 0) {
      this.dir.x = 0;
      this.dir.y = 0;
      this.magnitude = 0;
    } else {
      this.dir.x = x / len;
      this.dir.y = y / len;
      this.magnitude = 1;
    }
  }
}
