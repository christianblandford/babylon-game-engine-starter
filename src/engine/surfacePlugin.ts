import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { AbstractEngine, BaseTexture, MaterialDefines, Nullable, PBRMaterial, Scene, SubMesh, UniformBuffer } from "@babylonjs/core";

/**
 * Extends Babylon's standard PBR material, through its plugin system, with
 * the two things a big tiled surface needs that the stock material has no
 * setting for. Everything else (lighting, shadows, fog, both renderers) is
 * still the stock material's.
 *
 * **Breaking up repetition.** A tiled texture repeats on a grid, and across a
 * field the eye finds the grid at once. Three measures, strongest last:
 *
 * - blotches: a soft pattern a few repeats wide, slightly warm in places and
 *   cool in others, so no two repeats are quite the same colour;
 * - a second copy of the texture, shifted, shown in irregular patches, so the
 *   repeat itself stops being regular (`detile`). Right for organic surfaces
 *   (grass, earth, rock, plaster, bark); wrong for ones with courses or rows
 *   (masonry, roof tiles, planks), where the shifted copy would break the
 *   lines, so it is off unless asked for;
 * - with distance, a much larger copy takes over, because a grid shows most
 *   from far away (also part of `detile`).
 *
 * **Blending in a second surface through a mask** (`blend`): a path worn into
 * grass, sand at the water's edge. The mask is an image laid over the whole
 * terrain, white where the second surface shows. The boundary follows the
 * second surface's own texture, so earth breaks into grass in clumps instead
 * of fading across a ruled line.
 *
 * It works from world position and the material's own colour texture, and is
 * written twice, in GLSL for WebGL and WGSL for WebGPU. Keep the two in step.
 */

export interface SurfaceBlend {
  /** White where the second surface shows. */
  mask: BaseTexture;
  /** How world position maps onto the mask: u = x * map[0] + map[2], v = z * map[1] + map[3]. */
  map: [number, number, number, number];
  /** The second surface's colour texture, and how much ground one repeat of it covers (m). */
  albedo: BaseTexture;
  metres: number;
  /** The second surface's normal map, so it has its own relief (ruts and stones in a path) and not the grass's. */
  normal?: BaseTexture | null;
}

export interface SurfaceOptions {
  /** A soft, seamless greyscale pattern (see `variationTexture` in map.ts). */
  noise: BaseTexture;
  /** How much ground one repeat of the material's own texture covers (m). */
  metres: number;
  /** Strength of the blotches, 0 to 1. */
  variation?: number;
  /** Strength of the shifted and distant copies, 0 to 1. 0 (the default) leaves the texture's own layout alone. */
  detile?: number;
  blend?: SurfaceBlend;
}

const NAME = "MapSurface";

export class MapSurfacePlugin extends MaterialPluginBase {
  variation: number;
  detile: number;
  private readonly noise: BaseTexture;
  private readonly metres: number;
  private blend: SurfaceBlend | null;

  constructor(material: PBRMaterial, options: SurfaceOptions) {
    // 150: after the detail map (140), so its effect is included in what we adjust.
    super(material, NAME, 150, { MAPSURFACE: false, MAPSURFACE_DETILE: false, MAPSURFACE_BLEND: false, MAPSURFACE_BLEND_NORMAL: false }, true, false);
    this.noise = options.noise;
    this.metres = options.metres;
    this.variation = options.variation ?? 0.5;
    this.detile = options.detile ?? 0;
    this.blend = options.blend ?? null;
    this._enable(true);
  }

  /** Adds, changes or removes the blended-in surface. */
  setBlend(blend: SurfaceBlend | null): void {
    this.blend = blend;
    this.markAllDefinesAsDirty();
  }

  override getClassName(): string {
    return "MapSurfacePlugin";
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.GLSL || shaderLanguage === ShaderLanguage.WGSL;
  }

  override isReadyForSubMesh(_defines: MaterialDefines, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): boolean {
    const blend = this.blend;
    return this.noise.isReady() && (!blend || (blend.mask.isReady() && blend.albedo.isReady() && (!blend.normal || blend.normal.isReady())));
  }

  override prepareDefines(defines: MaterialDefines): void {
    const flags = defines as unknown as Record<string, boolean>;
    flags.MAPSURFACE = true;
    flags.MAPSURFACE_DETILE = this.detile > 0;
    flags.MAPSURFACE_BLEND = this.blend !== null;
    flags.MAPSURFACE_BLEND_NORMAL = !!this.blend?.normal;
  }

  override getSamplers(samplers: string[]): void {
    samplers.push("mapSurfaceNoise", "mapSurfaceMask", "mapSurfaceLayer", "mapSurfaceLayerNormal");
  }

  override getActiveTextures(activeTextures: BaseTexture[]): void {
    activeTextures.push(this.noise);
    if (this.blend) activeTextures.push(this.blend.mask, this.blend.albedo);
    if (this.blend?.normal) activeTextures.push(this.blend.normal);
  }

  override hasTexture(texture: BaseTexture): boolean {
    return texture === this.noise || texture === this.blend?.mask || texture === this.blend?.albedo || (!!this.blend?.normal && texture === this.blend.normal);
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return {
      ubo: [
        { name: "mapSurfaceInfo", size: 4, type: "vec4" }, // variation, detile, 1 / metres, layer is stored gamma-encoded
        { name: "mapSurfaceEye", size: 4, type: "vec4" }, // camera position; w: 1 / layer metres
        { name: "mapSurfaceMap", size: 4, type: "vec4" }, // world -> mask
      ],
      fragment: `uniform vec4 mapSurfaceInfo; uniform vec4 mapSurfaceEye; uniform vec4 mapSurfaceMap;`,
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene): void {
    const eye = scene.activeCamera?.globalPosition ?? scene.cameras[0]?.globalPosition;
    const blend = this.blend;
    uniformBuffer.updateFloat4("mapSurfaceInfo", this.variation, this.detile, 1 / this.metres, blend?.albedo.gammaSpace ? 1 : 0);
    uniformBuffer.updateFloat4("mapSurfaceEye", eye?.x ?? 0, eye?.y ?? 0, eye?.z ?? 0, blend ? 1 / blend.metres : 1);
    uniformBuffer.setTexture("mapSurfaceNoise", this.noise);
    if (blend) {
      uniformBuffer.updateFloat4("mapSurfaceMap", blend.map[0], blend.map[1], blend.map[2], blend.map[3]);
      uniformBuffer.setTexture("mapSurfaceMask", blend.mask);
      uniformBuffer.setTexture("mapSurfaceLayer", blend.albedo);
      if (blend.normal) uniformBuffer.setTexture("mapSurfaceLayerNormal", blend.normal);
    }
  }

  override getCustomCode(shaderType: string, shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL): Nullable<Record<string, string>> {
    if (shaderType !== "fragment") return null;
    return shaderLanguage === ShaderLanguage.WGSL ? WGSL : GLSL;
  }
}

// What the code below does, in both languages:
//
// 1. Blotches. Two samples of the noise at different sizes; one lightens and
//    darkens, the other shifts warm or cool.
// 2. Detile. `base` is the texture as the material sampled it. `shifted` is
//    the same texture moved over; `pick` (noise, a few repeats wide) chooses
//    between them. `wide` is the texture four or five times larger, faded in
//    between 25 and 90 m. The surface colour is multiplied by mixed / base,
//    which swaps the texture's contribution while keeping every tint already
//    applied to it.
// 3. Blend. The mask is read at the world position. The second surface's own
//    brightness (sampled coarsely) pushes the boundary in and out, and a
//    narrow smoothstep turns that into clumps with soft edges. Where the
//    second surface shows, its normal map replaces the first's: the frame it
//    is laid in is built from the surface normal with "across" along world x,
//    matching the world-position UVs the layer is sampled with. (Green is
//    subtracted: "up" in a glTF image is toward smaller v, and v runs along z.)

const GLSL: Record<string, string> = {
  CUSTOM_FRAGMENT_DEFINITIONS: `
#ifdef MAPSURFACE
uniform sampler2D mapSurfaceNoise;
#ifdef MAPSURFACE_BLEND
uniform sampler2D mapSurfaceMask;
uniform sampler2D mapSurfaceLayer;
#ifdef MAPSURFACE_BLEND_NORMAL
uniform sampler2D mapSurfaceLayerNormal;
#endif
#endif
#endif
`,
  CUSTOM_FRAGMENT_UPDATE_ALPHA: `
#ifdef MAPSURFACE
{
    vec2 msGround = vPositionW.xz + vPositionW.yy * vec2(0.37, 0.61);
    float msLight = texture2D(mapSurfaceNoise, msGround * 0.031).r;
    float msHue = texture2D(mapSurfaceNoise, msGround * 0.0113 + vec2(0.43, 0.17)).r;
    float msAmount = mapSurfaceInfo.x;
    surfaceAlbedo *= 1.0 + (msLight - 0.5) * 1.1 * msAmount;
    surfaceAlbedo *= mix(vec3(1.0), vec3(1.0) + (msHue - 0.5) * vec3(0.5, 0.05, -0.55), msAmount);

#if defined(MAPSURFACE_DETILE) && defined(ALBEDO)
    vec2 msUV = vAlbedoUV;
    vec3 msBase = texture2D(albedoSampler, msUV).rgb;
    vec3 msShifted = texture2D(albedoSampler, msUV + vec2(0.413, 0.287)).rgb;
    float msPick = smoothstep(0.4, 0.6, texture2D(mapSurfaceNoise, msUV * 0.173 + vec2(0.7, 0.2)).r);
    vec3 msWide = texture2D(albedoSampler, msUV * 0.217 + vec2(0.31, 0.77)).rgb;
    float msFar = smoothstep(25.0, 90.0, distance(mapSurfaceEye.xyz, vPositionW));
    vec3 msMixed = mix(mix(msBase, msShifted, msPick), msWide, msFar * 0.85);
    vec3 msSwap = (msMixed + 0.03) / (msBase + 0.03);
#ifdef GAMMAALBEDO
    msSwap = pow(msSwap, vec3(2.2));
#endif
    surfaceAlbedo *= mix(vec3(1.0), msSwap, mapSurfaceInfo.y);
#endif

#ifdef MAPSURFACE_BLEND
    float msMask = texture2D(mapSurfaceMask, vPositionW.xz * mapSurfaceMap.xy + mapSurfaceMap.zw).r;
    vec2 msLayerUV = vPositionW.xz * mapSurfaceEye.w;
    vec3 msLayer = texture2D(mapSurfaceLayer, msLayerUV).rgb;
    vec3 msLayerWide = texture2D(mapSurfaceLayer, msLayerUV * 0.23 + vec2(0.6, 0.1)).rgb;
    msLayer = mix(msLayer, msLayerWide, 0.35);
    msLayer = mix(msLayer, pow(msLayer, vec3(2.2)), mapSurfaceInfo.w);
    float msClumps = texture2D(mapSurfaceNoise, vPositionW.xz * 0.41).r + texture2D(mapSurfaceLayer, msLayerUV * 1.7).g - 1.0;
    float msWeight = smoothstep(0.38, 0.62, msMask + msClumps * 0.42 * (1.0 - abs(msMask * 2.0 - 1.0)));
    surfaceAlbedo = mix(surfaceAlbedo, msLayer * (1.0 + (msLight - 0.5) * 0.7 * msAmount), msWeight);
#ifdef MAPSURFACE_BLEND_NORMAL
    vec3 msRelief = texture2D(mapSurfaceLayerNormal, msLayerUV).xyz * 2.0 - 1.0;
    vec3 msAcross = normalize(cross(normalW, vec3(0.0, 0.0, 1.0)) + vec3(0.0001, 0.0, 0.0));
    vec3 msAlong = cross(msAcross, normalW);
    normalW = normalize(mix(normalW, normalize(msAcross * msRelief.x - msAlong * msRelief.y + normalW * msRelief.z), msWeight));
#endif
#endif
}
#endif
`,
};

const WGSL: Record<string, string> = {
  CUSTOM_FRAGMENT_DEFINITIONS: `
#ifdef MAPSURFACE
var mapSurfaceNoiseSampler: sampler;
var mapSurfaceNoise: texture_2d<f32>;
#ifdef MAPSURFACE_BLEND
var mapSurfaceMaskSampler: sampler;
var mapSurfaceMask: texture_2d<f32>;
var mapSurfaceLayerSampler: sampler;
var mapSurfaceLayer: texture_2d<f32>;
#ifdef MAPSURFACE_BLEND_NORMAL
var mapSurfaceLayerNormalSampler: sampler;
var mapSurfaceLayerNormal: texture_2d<f32>;
#endif
#endif
#endif
`,
  CUSTOM_FRAGMENT_UPDATE_ALPHA: `
#ifdef MAPSURFACE
{
    let msWorld: vec3f = fragmentInputs.vPositionW;
    let msGround: vec2f = msWorld.xz + msWorld.yy * vec2f(0.37, 0.61);
    let msLight: f32 = textureSample(mapSurfaceNoise, mapSurfaceNoiseSampler, msGround * 0.031).r;
    let msHue: f32 = textureSample(mapSurfaceNoise, mapSurfaceNoiseSampler, msGround * 0.0113 + vec2f(0.43, 0.17)).r;
    let msAmount: f32 = uniforms.mapSurfaceInfo.x;
    surfaceAlbedo = surfaceAlbedo * (1.0 + (msLight - 0.5) * 1.1 * msAmount);
    surfaceAlbedo = surfaceAlbedo * mix(vec3f(1.0), vec3f(1.0) + (msHue - 0.5) * vec3f(0.5, 0.05, -0.55), msAmount);

#if defined(MAPSURFACE_DETILE) && defined(ALBEDO)
    let msUV: vec2f = fragmentInputs.vAlbedoUV;
    let msBase: vec3f = textureSample(albedoSampler, albedoSamplerSampler, msUV).rgb;
    let msShifted: vec3f = textureSample(albedoSampler, albedoSamplerSampler, msUV + vec2f(0.413, 0.287)).rgb;
    let msPick: f32 = smoothstep(0.4, 0.6, textureSample(mapSurfaceNoise, mapSurfaceNoiseSampler, msUV * 0.173 + vec2f(0.7, 0.2)).r);
    let msWide: vec3f = textureSample(albedoSampler, albedoSamplerSampler, msUV * 0.217 + vec2f(0.31, 0.77)).rgb;
    let msFar: f32 = smoothstep(25.0, 90.0, distance(uniforms.mapSurfaceEye.xyz, msWorld));
    let msMixed: vec3f = mix(mix(msBase, msShifted, msPick), msWide, msFar * 0.85);
    var msSwap: vec3f = (msMixed + vec3f(0.03)) / (msBase + vec3f(0.03));
#ifdef GAMMAALBEDO
    msSwap = pow(msSwap, vec3f(2.2));
#endif
    surfaceAlbedo = surfaceAlbedo * mix(vec3f(1.0), msSwap, uniforms.mapSurfaceInfo.y);
#endif

#ifdef MAPSURFACE_BLEND
    let msMask: f32 = textureSample(mapSurfaceMask, mapSurfaceMaskSampler, msWorld.xz * uniforms.mapSurfaceMap.xy + uniforms.mapSurfaceMap.zw).r;
    let msLayerUV: vec2f = msWorld.xz * uniforms.mapSurfaceEye.w;
    var msLayer: vec3f = textureSample(mapSurfaceLayer, mapSurfaceLayerSampler, msLayerUV).rgb;
    let msLayerWide: vec3f = textureSample(mapSurfaceLayer, mapSurfaceLayerSampler, msLayerUV * 0.23 + vec2f(0.6, 0.1)).rgb;
    msLayer = mix(msLayer, msLayerWide, 0.35);
    msLayer = mix(msLayer, pow(msLayer, vec3f(2.2)), uniforms.mapSurfaceInfo.w);
    let msClumps: f32 = textureSample(mapSurfaceNoise, mapSurfaceNoiseSampler, msWorld.xz * 0.41).r + textureSample(mapSurfaceLayer, mapSurfaceLayerSampler, msLayerUV * 1.7).g - 1.0;
    let msWeight: f32 = smoothstep(0.38, 0.62, msMask + msClumps * 0.42 * (1.0 - abs(msMask * 2.0 - 1.0)));
    surfaceAlbedo = mix(surfaceAlbedo, msLayer * (1.0 + (msLight - 0.5) * 0.7 * msAmount), msWeight);
#ifdef MAPSURFACE_BLEND_NORMAL
    let msRelief: vec3f = textureSample(mapSurfaceLayerNormal, mapSurfaceLayerNormalSampler, msLayerUV).xyz * 2.0 - vec3f(1.0);
    let msAcross: vec3f = normalize(cross(normalW, vec3f(0.0, 0.0, 1.0)) + vec3f(0.0001, 0.0, 0.0));
    let msAlong: vec3f = cross(msAcross, normalW);
    normalW = normalize(mix(normalW, normalize(msAcross * msRelief.x - msAlong * msRelief.y + normalW * msRelief.z), msWeight));
#endif
#endif
}
#endif
`,
};
