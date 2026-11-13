/**
 * Action-based input: game code asks "is `jump` down?" rather than "is Space
 * down?", so keys can be rebound and keyboard, mouse and gamepad all feed the
 * same actions.
 *
 * Frame protocol (handled by main.ts):
 *   input.update()   at the start of the frame  (polls the gamepad)
 *   ...game logic reads input...
 *   input.endFrame() after rendering            (clears per-frame state)
 */

export type Action = "forward" | "back" | "left" | "right" | "jump" | "sprint" | "interact" | "toggleView" | "pause";

/** Keyboard bindings, as `KeyboardEvent.code` values (layout-independent). */
export const DEFAULT_KEY_BINDINGS: Record<Action, string[]> = {
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  jump: ["Space"],
  sprint: ["ShiftLeft", "ShiftRight"],
  interact: ["KeyE"],
  toggleView: ["KeyV"],
  pause: ["Escape", "KeyP"],
};

/** Gamepad bindings, as button indices of the W3C "standard" mapping. */
export const DEFAULT_PAD_BINDINGS: Partial<Record<Action, number[]>> = {
  jump: [0], // A / Cross
  interact: [2], // X / Square
  sprint: [10, 6], // left stick click, left trigger
  toggleView: [11], // right stick click
  pause: [9], // Start / Options
};

const STICK_DEADZONE = 0.15;

export interface Vec2 {
  x: number;
  y: number;
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function deadzone(v: number): number {
  const a = Math.abs(v);
  return a < STICK_DEADZONE ? 0 : (Math.sign(v) * (a - STICK_DEADZONE)) / (1 - STICK_DEADZONE);
}

export class Input {
  keyBindings: Record<Action, string[]> = structuredClone(DEFAULT_KEY_BINDINGS);
  padBindings: Partial<Record<Action, number[]>> = structuredClone(DEFAULT_PAD_BINDINGS);

  /** When true, clicking the canvas captures the mouse (Esc releases it). */
  pointerLockOnClick = true;

  /** True while the mouse is captured by the canvas. */
  get pointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /**
   * Movement intent this frame. `x` is right (+) / left (-), `y` is forward (+)
   * / back (-). Keyboard and left stick combined; length never exceeds 1.
   */
  readonly move: Vec2 = { x: 0, y: 0 };

  /**
   * Mouse movement this frame in pixels (`x` right, `y` down). Only reported
   * while the pointer is locked or a mouse button is held on the canvas.
   */
  readonly look: Vec2 = { x: 0, y: 0 };

  /** Right gamepad stick, -1..1 per axis (`x` right, `y` down). A rate, not a delta. */
  readonly lookStick: Vec2 = { x: 0, y: 0 };

  /** Mouse wheel movement this frame, in "notches" (+ = scroll down / zoom out). */
  wheel = 0;

  private readonly keysDown = new Set<string>();
  private readonly keysPressed = new Set<string>();
  private readonly mouseDown = new Set<number>();
  private readonly mousePressed = new Set<number>();
  private padDown = new Set<number>();
  private readonly padPressed = new Set<number>();
  private readonly abort = new AbortController();

  constructor(private readonly canvas: HTMLCanvasElement) {
    const on = { signal: this.abort.signal };
    const active = { signal: this.abort.signal, passive: false };

    window.addEventListener("keydown", this.onKeyDown, on);
    window.addEventListener("keyup", (e) => this.keysDown.delete(e.code), on);
    window.addEventListener("blur", this.releaseAll, on);
    document.addEventListener("visibilitychange", this.releaseAll, on);

    canvas.addEventListener("pointerdown", this.onPointerDown, on);
    window.addEventListener("pointerup", (e) => this.mouseDown.delete(e.button), on);
    window.addEventListener("mousemove", this.onMouseMove, on);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault(), on);

    // The game owns the wheel over the canvas; never let it scroll the page.
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (!e.ctrlKey) this.wheel += Math.sign(e.deltaY) * Math.min(1, Math.abs(e.deltaY) / 100);
      },
      active,
    );
    // Trackpad pinch arrives as ctrl+wheel (Chrome/Firefox) or gesture events
    // (Safari). Left alone, the browser zooms the whole page under the HUD.
    window.addEventListener("wheel", (e) => e.ctrlKey && e.preventDefault(), active);
    for (const type of ["gesturestart", "gesturechange"]) {
      window.addEventListener(type, (e) => e.preventDefault(), active);
    }
  }

  /** True while any key/button bound to the action is held. */
  isDown(action: Action): boolean {
    return (
      this.keyBindings[action].some((code) => this.keysDown.has(code)) ||
      (this.padBindings[action]?.some((button) => this.padDown.has(button)) ?? false)
    );
  }

  /** True only on the frame the action went from up to down. */
  wasPressed(action: Action): boolean {
    return (
      this.keyBindings[action].some((code) => this.keysPressed.has(code)) ||
      (this.padBindings[action]?.some((button) => this.padPressed.has(button)) ?? false)
    );
  }

  /** What to call an action's key on screen: "E" for `interact` by default. */
  labelFor(action: Action): string {
    const code = this.keyBindings[action][0] ?? "";
    return code.replace(/^(Key|Digit)/, "").replace(/(Left|Right)$/, "");
  }

  /** Raw key state, for one-off debug keys. Prefer actions in game code. */
  isKeyDown(code: string): boolean {
    return this.keysDown.has(code);
  }

  wasKeyPressed(code: string): boolean {
    return this.keysPressed.has(code);
  }

  /** 0 = left, 1 = middle, 2 = right. */
  isMouseDown(button = 0): boolean {
    return this.mouseDown.has(button);
  }

  wasMousePressed(button = 0): boolean {
    return this.mousePressed.has(button);
  }

  requestPointerLock(): void {
    if (!this.pointerLocked) void Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
  }

  exitPointerLock(): void {
    if (this.pointerLocked) document.exitPointerLock();
  }

  /** Call once at the start of every frame. */
  update(): void {
    const pad = navigator.getGamepads?.().find((p) => p?.connected && p.mapping === "standard") ?? null;

    const nowDown = new Set<number>();
    let stickX = 0;
    let stickY = 0;
    this.lookStick.x = 0;
    this.lookStick.y = 0;
    if (pad) {
      pad.buttons.forEach((button, index) => {
        if (!button.pressed) return;
        nowDown.add(index);
        if (!this.padDown.has(index)) this.padPressed.add(index);
      });
      stickX = deadzone(pad.axes[0] ?? 0);
      stickY = -deadzone(pad.axes[1] ?? 0);
      this.lookStick.x = deadzone(pad.axes[2] ?? 0);
      this.lookStick.y = deadzone(pad.axes[3] ?? 0);
    }
    this.padDown = nowDown;

    let x = stickX + (this.isDown("right") ? 1 : 0) - (this.isDown("left") ? 1 : 0);
    let y = stickY + (this.isDown("forward") ? 1 : 0) - (this.isDown("back") ? 1 : 0);
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    this.move.x = x;
    this.move.y = y;
  }

  /** Call once after every frame has rendered. */
  endFrame(): void {
    this.keysPressed.clear();
    this.mousePressed.clear();
    this.padPressed.clear();
    this.look.x = 0;
    this.look.y = 0;
    this.wheel = 0;
  }

  dispose(): void {
    this.abort.abort();
    this.exitPointerLock();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const bound = Object.values(this.keyBindings).some((codes) => codes.includes(e.code));
    if (bound) e.preventDefault(); // stop Space / arrows from scrolling the page
    if (e.repeat) return;
    this.keysDown.add(e.code);
    this.keysPressed.add(e.code);
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.mouseDown.add(e.button);
    this.mousePressed.add(e.button);
    if (this.pointerLockOnClick && e.pointerType === "mouse") this.requestPointerLock();
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked && this.mouseDown.size === 0) return;
    this.look.x += e.movementX;
    this.look.y += e.movementY;
  };

  private readonly releaseAll = (): void => {
    this.keysDown.clear();
    this.mouseDown.clear();
  };
}
