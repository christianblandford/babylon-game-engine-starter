import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { MaterialDefines, Nullable, PBRMaterial, UniformBuffer } from "@babylonjs/core";
import type { GameContext } from "./context";

/**
 * Wind: grass and leaves that move.
 *
 * Nothing is animated on the CPU. Each vertex of a plant carries, in its
 * second UV map, how much it should sway (u: 0 at the root or the base of
 * the trunk, 1 at a blade's tip or a leaf) and a phase (v: 0..1, the same
 * along one branch, different from the next). A small extension to the
 * standard material's vertex shader pushes vertices downwind by that much:
 * a slow gust that rolls across the land, with a quicker flutter on top.
 * It costs a few instructions per vertex and works for instanced plants.
 *
 * A plant gets it by its material: `wind.attach(material)`. Map materials
 * with the custom property `wind` (set on foliage by tools/blender/plants.py)
 * are attached by the map loader; the value scales the sway.
 *
 * Shadows are drawn by a different shader and stay still. At these
 * amplitudes that isn't noticeable.
 */

export interface Wind {
  /** How far a fully exposed leaf or blade tip moves at the height of a gust (m). */
  strength: number;
  /** Compass direction the wind blows toward, as an x, z pair. */
  direction: [number, number];
  /** Makes a material's plants sway. `amount` scales it for that material (grass more than oak). */
  attach(material: PBRMaterial, amount?: number): void;
  dispose(): void;
}

const NAME = "Wind";

class WindPlugin extends MaterialPluginBase {
  constructor(
    material: PBRMaterial,
    private readonly state: { time: number; wind: Wind },
    private readonly amount: number,
  ) {
    super(material, NAME, 120, { WIND: false }, true, true);
  }

  override getClassName(): string {
    return "WindPlugin";
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.GLSL || shaderLanguage === ShaderLanguage.WGSL;
  }

  // The sway is read from the second UV map, which the material only asks
  // for when one of its textures uses UVs. Grass has no textures, so ask.
  override prepareDefinesBeforeAttributes(defines: MaterialDefines): void {
    (defines as unknown as { _needUVs: boolean })._needUVs = true;
  }

  override prepareDefines(defines: MaterialDefines): void {
    (defines as unknown as Record<string, boolean>).WIND = true;
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; vertex: string } {
    return { ubo: [{ name: "windInfo", size: 4, type: "vec4" }], vertex: `uniform vec4 windInfo;` };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    const { time, wind } = this.state;
    uniformBuffer.updateFloat4("windInfo", time, wind.strength * this.amount, wind.direction[0], wind.direction[1]);
  }

  override getCustomCode(shaderType: string, shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL): Nullable<Record<string, string>> {
    if (shaderType !== "vertex") return null;
    return shaderLanguage === ShaderLanguage.WGSL ? WGSL : GLSL;
  }
}

// Both versions: `gust` is a slow wave travelling across the land (so a field
// ripples rather than nodding in unison), `flutter` two quicker sines with the
// vertex's own phase. The push is along the wind, scaled by the vertex's sway
// weight, with a little droop so a bent blade doesn't get longer.

const GLSL: Record<string, string> = {
  CUSTOM_VERTEX_UPDATE_WORLDPOS: `
#if defined(WIND) && defined(UV2)
{
    float windWeight = uv2Updated.x * windInfo.y;
    float windPhase = uv2Updated.y * 6.2831853;
    float windGust = 0.55 + 0.45 * sin(windInfo.x * 0.7 + dot(worldPos.xz, vec2(0.085, 0.06)));
    float windFlutter = sin(windInfo.x * 2.1 + windPhase + worldPos.x * 0.37) * 0.65 + sin(windInfo.x * 4.7 + windPhase * 2.3 + worldPos.z * 0.71) * 0.35;
    vec2 windPush = windInfo.zw * (windGust * (0.6 + 0.4 * windFlutter)) * windWeight;
    worldPos.xz += windPush;
    worldPos.y -= length(windPush) * 0.3 * uv2Updated.x;
}
#endif
`,
};

const WGSL: Record<string, string> = {
  CUSTOM_VERTEX_UPDATE_WORLDPOS: `
#if defined(WIND) && defined(UV2)
{
    let windWeight: f32 = uv2Updated.x * uniforms.windInfo.y;
    let windPhase: f32 = uv2Updated.y * 6.2831853;
    let windGust: f32 = 0.55 + 0.45 * sin(uniforms.windInfo.x * 0.7 + dot(worldPos.xz, vec2f(0.085, 0.06)));
    let windFlutter: f32 = sin(uniforms.windInfo.x * 2.1 + windPhase + worldPos.x * 0.37) * 0.65 + sin(uniforms.windInfo.x * 4.7 + windPhase * 2.3 + worldPos.z * 0.71) * 0.35;
    let windPush: vec2f = uniforms.windInfo.zw * (windGust * (0.6 + 0.4 * windFlutter)) * windWeight;
    worldPos = vec4f(worldPos.x + windPush.x, worldPos.y - length(windPush) * 0.3 * uv2Updated.x, worldPos.z + windPush.y, worldPos.w);
}
#endif
`,
};

export function createWind(ctx: GameContext): Wind {
  const { scene, clock } = ctx;
  const state = { time: 0, wind: null as unknown as Wind };
  // Game time, so the wind stops with everything else when the game is paused.
  const observer = scene.onBeforeRenderObservable.add(() => {
    state.time += clock.delta;
  });
  const wind: Wind = {
    strength: 0.09,
    direction: [0.8, 0.6],
    attach(material, amount = 1) {
      if (material.pluginManager?.getPlugin(NAME)) return;
      new WindPlugin(material, state, amount);
    },
    dispose() {
      scene.onBeforeRenderObservable.remove(observer);
    },
  };
  state.wind = wind;
  return wind;
}
