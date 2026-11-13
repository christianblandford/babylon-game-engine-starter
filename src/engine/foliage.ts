import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { DirectionalLight, MaterialDefines, Nullable, PBRMaterial, UniformBuffer } from "@babylonjs/core";

/**
 * Leaf cards that hold up at a distance and edge-on.
 *
 * A tree's foliage is flat cards, each showing a painted twig with the gaps
 * between leaves cut out (tools/blender/plants.py). Drawn with a plain alpha
 * cut-off, two things go wrong:
 *
 * - **Trees go bald with distance.** Far away the texture is read from its
 *   small, blurred copies, where a twig that was "leaf here, gap there" has
 *   become an even 40% everywhere. That is below the cut-off, so the whole
 *   card vanishes. Raising the cut-off's opposite number doesn't help: then
 *   the whole card turns solid. What is wanted is 40% of the card, and that
 *   is what this does: as the texture blurs, the cut-off is replaced by a
 *   fixed random value per small patch of the card, so a patch survives as
 *   often as there is leaf in it. Near the camera nothing changes.
 * - **A card seen edge-on is a streak.** Those are cut away: thinner the
 *   closer the card is to edge-on.
 *
 * The material's own cut-off (`alphaCutOff`) is set low and left to the
 * shadow pass, which this code is not part of: shadows are cast by slightly
 * fuller leaves, and never thin out.
 *
 * **Light through the leaves.** A leaf lets through about as much light as it
 * reflects, which is why a tree seen against the sun glows at its edges
 * instead of standing as a black shape. Cards let nothing through, and
 * Babylon's own translucency is cancelled by the crown's shadow on itself.
 * So this adds the glow directly: leaf colour, tinted yellow-green, strongest
 * where the view is toward the sun and the surface faces away from it. It
 * ignores shadows on purpose; the crown's inside is already darkened in the
 * mesh's vertex colours, which keeps the glow to the fringe.
 */

export interface FoliageOptions {
  /** Where a leaf ends, near the camera (the cut-off the texture was painted for). */
  cutoff?: number;
  /** The leaf texture is this many pixels across. */
  textureSize?: number;
  /** How many patches across the texture decide their fate separately at a distance. */
  patches?: number;
  /** The sun, for light through the leaves. Without it there is none. */
  sun?: DirectionalLight;
  /** How strong that light is, as a share of full sunlight on the leaf (default 0.5). */
  through?: number;
}

const NAME = "Foliage";

export class FoliagePlugin extends MaterialPluginBase {
  private readonly cutoff: number;
  private readonly textureSize: number;
  private readonly patches: number;
  private readonly sun: DirectionalLight | null;
  private readonly through: number;

  constructor(material: PBRMaterial, options: FoliageOptions = {}) {
    super(material, NAME, 160, { FOLIAGE: false }, true, true);
    this.cutoff = options.cutoff ?? 0.5;
    this.textureSize = options.textureSize ?? 1024;
    this.patches = options.patches ?? 96;
    this.sun = options.sun ?? null;
    this.through = options.through ?? 0.5;
  }

  override getClassName(): string {
    return "FoliagePlugin";
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.GLSL || shaderLanguage === ShaderLanguage.WGSL;
  }

  override prepareDefines(defines: MaterialDefines): void {
    (defines as unknown as Record<string, boolean>).FOLIAGE = true;
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return {
      ubo: [
        { name: "foliageInfo", size: 4, type: "vec4" }, // texture size, patches, cut-off
        { name: "foliageSun", size: 4, type: "vec4" }, // direction toward the sun
        { name: "foliageGlow", size: 4, type: "vec4" }, // colour and strength of light through the leaves
      ],
      fragment: `uniform vec4 foliageInfo; uniform vec4 foliageSun; uniform vec4 foliageGlow;`,
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.updateFloat4("foliageInfo", this.textureSize, this.patches, this.cutoff, 0);
    const sun = this.sun;
    if (sun) {
      const strength = sun.intensity * this.through;
      // What comes through a leaf is yellower and greener than what bounces off it.
      uniformBuffer.updateFloat4("foliageSun", -sun.direction.x, -sun.direction.y, -sun.direction.z, 0);
      uniformBuffer.updateFloat4("foliageGlow", sun.diffuse.r * 1.1 * strength, sun.diffuse.g * 1.25 * strength, sun.diffuse.b * 0.45 * strength, 0);
    } else {
      uniformBuffer.updateFloat4("foliageSun", 0, 1, 0, 0);
      uniformBuffer.updateFloat4("foliageGlow", 0, 0, 0, 0);
    }
  }

  override getCustomCode(shaderType: string, shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL): Nullable<Record<string, string>> {
    if (shaderType !== "fragment") return null;
    return shaderLanguage === ShaderLanguage.WGSL ? WGSL : GLSL;
  }
}

// Both versions: `foBlur` is how many times the texture has been halved for
// this pixel (0 up close). `foPatch` is a random number fixed to a patch of
// the card. The cut-off slides from the painted one to the patch's own as the
// blur passes one to three halvings; edge-on cards (`foFacing` near 0) have it
// pushed up to "nothing passes".

const GLSL: Record<string, string> = {
  CUSTOM_FRAGMENT_UPDATE_ALPHA: `
#if defined(FOLIAGE) && defined(ALBEDO)
{
    float foLeaf = texture2D(albedoSampler, vAlbedoUV).a;
    vec2 foTexel = vAlbedoUV * foliageInfo.x;
    vec2 foAcross = dFdx(foTexel);
    vec2 foDown = dFdy(foTexel);
    float foBlur = max(0.0, 0.5 * log2(max(dot(foAcross, foAcross), dot(foDown, foDown))));
    float foPatch = fract(sin(dot(floor(vAlbedoUV * foliageInfo.y), vec2(12.9898, 78.233))) * 43758.5453);
    float foCut = mix(foliageInfo.z, 0.1 + 0.8 * foPatch, smoothstep(1.0, 3.0, foBlur));
    float foFacing = abs(dot(normalize(cross(dFdx(vPositionW), dFdy(vPositionW))), viewDirectionW));
    foCut = mix(1.01, foCut, smoothstep(0.02, 0.22, foFacing));
    if (foLeaf < foCut) discard;
}
#endif
`,
  // `foToward`: how nearly the view is straight at the sun. `foAway`: how far
  // the surface is turned from it (a leaf lit from the front needs no help).
  CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
#ifdef FOLIAGE
{
    float foToward = pow(clamp(dot(-viewDirectionW, foliageSun.xyz), 0.0, 1.0), 3.0);
    float foAway = clamp(0.6 - dot(normalW, foliageSun.xyz), 0.0, 1.0);
    finalDiffuse += surfaceAlbedo * foliageGlow.rgb * (foToward * foAway);
}
#endif
`,
};

const WGSL: Record<string, string> = {
  CUSTOM_FRAGMENT_UPDATE_ALPHA: `
#if defined(FOLIAGE) && defined(ALBEDO)
{
    let foLeaf: f32 = textureSample(albedoSampler, albedoSamplerSampler, fragmentInputs.vAlbedoUV).a;
    let foTexel: vec2f = fragmentInputs.vAlbedoUV * uniforms.foliageInfo.x;
    let foAcross: vec2f = dpdx(foTexel);
    let foDown: vec2f = dpdy(foTexel);
    let foBlur: f32 = max(0.0, 0.5 * log2(max(dot(foAcross, foAcross), dot(foDown, foDown))));
    let foPatch: f32 = fract(sin(dot(floor(fragmentInputs.vAlbedoUV * uniforms.foliageInfo.y), vec2f(12.9898, 78.233))) * 43758.5453);
    var foCut: f32 = mix(uniforms.foliageInfo.z, 0.1 + 0.8 * foPatch, smoothstep(1.0, 3.0, foBlur));
    let foFacing: f32 = abs(dot(normalize(cross(dpdx(fragmentInputs.vPositionW), dpdy(fragmentInputs.vPositionW))), viewDirectionW));
    foCut = mix(1.01, foCut, smoothstep(0.02, 0.22, foFacing));
    if (foLeaf < foCut) {
        discard;
    }
}
#endif
`,
  CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
#ifdef FOLIAGE
{
    let foToward: f32 = pow(clamp(dot(-viewDirectionW, uniforms.foliageSun.xyz), 0.0, 1.0), 3.0);
    let foAway: f32 = clamp(0.6 - dot(normalW, uniforms.foliageSun.xyz), 0.0, 1.0);
    finalDiffuse = finalDiffuse + surfaceAlbedo * uniforms.foliageGlow.rgb * (foToward * foAway);
}
#endif
`,
};
