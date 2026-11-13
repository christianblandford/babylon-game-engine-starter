import { Observable } from "@babylonjs/core/Misc/observable";
import type { IParticleSystem, Scene } from "@babylonjs/core";

/** Longest slice of time simulated in one frame, so a hitch can't fling things through walls. */
const MAX_DELTA = 1 / 20;

/**
 * The game's notion of time. Anything that moves on its own (characters, AI,
 * timers) should advance by `clock.delta` rather than the raw frame time, so
 * that pausing stops it.
 */
export interface GameClock {
  /** Seconds to simulate this frame: 0 while paused, and capped after a hitch. */
  readonly delta: number;
  /** True while the game is paused (menu open). Rendering continues; simulation doesn't. */
  paused: boolean;
  readonly onPauseChanged: Observable<boolean>;
}

/**
 * Creates the clock for a scene. Pausing also freezes what Babylon simulates
 * itself: physics, animations and particles.
 */
export function createClock(scene: Scene): GameClock {
  const engine = scene.getEngine();
  const onPauseChanged = new Observable<boolean>();
  let paused = false;
  const particleSpeeds = new Map<IParticleSystem, number>();
  scene.onDisposeObservable.addOnce(() => onPauseChanged.clear());

  return {
    get delta() {
      return paused ? 0 : Math.min(engine.getDeltaTime() / 1000, MAX_DELTA);
    },
    get paused() {
      return paused;
    },
    set paused(value: boolean) {
      if (value === paused) return;
      paused = value;
      scene.physicsEnabled = !value;
      scene.animationsEnabled = !value;
      // Particles have no global switch that keeps them on screen but still.
      for (const system of scene.particleSystems) {
        if (value) {
          particleSpeeds.set(system, system.updateSpeed);
          system.updateSpeed = 0;
        } else {
          system.updateSpeed = particleSpeeds.get(system) ?? system.updateSpeed;
        }
      }
      if (!value) particleSpeeds.clear();
      onPauseChanged.notifyObservers(value);
    },
    onPauseChanged,
  };
}
