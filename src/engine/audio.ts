import { CreateSoundAsync } from "@babylonjs/core/AudioV2/abstractAudio/audioEngineV2";
import { CreateAudioEngineAsync } from "@babylonjs/core/AudioV2/webAudio/webAudioEngine";
import type { AudioEngineV2, StaticSound } from "@babylonjs/core";
import type { AudioSystem } from "./context";

export interface SynthOptions {
  /** Seconds. */
  duration: number;
  /** Start pitch in Hz. */
  frequency: number;
  /** End pitch in Hz (sweeps from `frequency`). Defaults to no sweep. */
  frequencyEnd?: number;
  /** 0 = pure tone, 1 = pure noise. */
  noise?: number;
  /** Peak amplitude, 0..1. */
  gain?: number;
}

export interface GameAudio extends AudioSystem {
  /**
   * Registers a tiny synthesised sound effect, so prototypes can have audio
   * feedback before any sound files exist. Swap for `load()` later.
   */
  synth(name: string, options: SynthOptions): Promise<void>;
}

const SAMPLE_RATE = 44100;

function renderSynth({ duration, frequency, frequencyEnd = frequency, noise = 0, gain = 0.5 }: SynthOptions): AudioBuffer {
  const length = Math.max(1, Math.floor(duration * SAMPLE_RATE));
  const buffer = new AudioBuffer({ length, sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
  const data = buffer.getChannelData(0);
  let phase = 0;
  let smoothed = 0;
  for (let i = 0; i < length; i++) {
    const t = i / length;
    phase += (2 * Math.PI * (frequency + (frequencyEnd - frequency) * t)) / SAMPLE_RATE;
    smoothed += (Math.random() * 2 - 1 - smoothed) * 0.12; // low-passed noise: a thud, not a hiss
    const envelope = Math.min(1, i / 120) * (1 - t) ** 2; // short attack, smooth decay
    data[i] = gain * envelope * ((1 - noise) * Math.sin(phase) + noise * smoothed * 3);
  }
  return buffer;
}

/**
 * Starts Babylon's audio engine. Browsers keep audio muted until the player
 * interacts with the page; the engine resumes itself on the first click or key
 * press, so `play()` is always safe to call.
 */
export async function createAudio(): Promise<GameAudio> {
  let engine: AudioEngineV2 | null = null;
  try {
    engine = await CreateAudioEngineAsync({ volume: 0.7 });
  } catch (error) {
    console.warn("Audio is unavailable; continuing without sound.", error);
  }
  const sounds = new Map<string, StaticSound>();

  async function register(name: string, source: string | AudioBuffer): Promise<void> {
    if (!engine) return;
    sounds.get(name)?.dispose();
    sounds.set(name, await CreateSoundAsync(name, source, { maxInstances: 4 }, engine));
  }

  return {
    play(name, options) {
      const sound = sounds.get(name);
      if (!sound) return;
      sound.playbackRate = options?.playbackRate ?? 1;
      sound.play({ volume: options?.volume ?? 1 });
    },
    load: (name, url) => register(name, url),
    synth: (name, options) => register(name, renderSynth(options)),
    get masterVolume() {
      return engine?.volume ?? 0;
    },
    set masterVolume(value: number) {
      if (engine) engine.volume = Math.min(1, Math.max(0, value));
    },
  };
}
