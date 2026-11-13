import type { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import type { Plane } from "@babylonjs/core/Maths/math.plane";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core";

/**
 * Leaves out of each shadow cascade the casters that cannot matter to it.
 *
 * A cascade is a slab of the view, and Babylon draws every shadow caster
 * into every cascade, four times over; in a town that is most of the frame's
 * draw calls. Two tests thin that out:
 *
 * - **Reach.** A caster can only matter to a cascade if it lies within that
 *   cascade's box as seen from the sun, or between the box and the sun (so
 *   the box's two ends are not tested, only its four sides).
 * - **Size.** A far cascade covers 100 m or more with the same number of
 *   texels the nearest spends on 6 m. A lamp or a flower box is then a
 *   handful of texels, which the shadow filter smears into nothing; it is
 *   left out of any cascade where it is under `SMALLEST` texels across.
 *
 * A mesh drawn as one batch of many placings (see `batches` in map.ts) has
 * bounds that span the whole map, so by itself it would pass both tests in
 * every cascade. The map therefore describes each batch with
 * `setCasterGroups`: a sphere around the placings each chunk contributes, and
 * how big one placing is. The batch is drawn into a cascade only if one of
 * its groups reaches it, and never into a cascade where a single placing is
 * too small to show.
 *
 * In the test town the two tests on batches took the shadow pass from 523
 * draws to 423 with no visible difference (it was over 900 with no culling
 * at all). What is left is mostly the last cascade, which covers the whole
 * town and so has to draw most of it.
 */

/** A caster's shadow narrower than this many texels (its radius, so half its width) is not drawn. */
const SMALLEST = 5;

export interface CasterGroups {
  /** World-space spheres, four numbers each (x, y, z, radius): one around each group of placings. */
  spheres: Float32Array;
  /** The radius of a single placing. */
  size: number;
}

const groupsOf = new WeakMap<AbstractMesh, CasterGroups>();

/** Describes a mesh that is drawn many times over a wide area (or forgets it, with null). */
export function setCasterGroups(mesh: AbstractMesh, groups: CasterGroups | null): void {
  if (groups) groupsOf.set(mesh, groups);
  else groupsOf.delete(mesh);
}

export function cullShadowCascades(generator: CascadedShadowGenerator): void {
  const map = generator.getShadowMap();
  if (!map) return;
  const sides: Plane[] = Frustum.GetPlanes(Matrix.Identity()); // near, far, left, right, top, bottom
  const perCascade: AbstractMesh[][] = [];
  map.getCustomRenderList = (cascade, list, length) => {
    const box = generator.getCascadeTransformMatrix(cascade);
    if (!list || !box) return null;
    Frustum.GetPlanesToRef(box, sides);
    // The cascade's box is two units wide in its own space; how many metres
    // that is can be read off the matrix, and from it the size of a texel.
    const m = box.m;
    const texel = 2 / Math.hypot(m[0]!, m[4]!, m[8]!) / map.getSize().width;
    const smallest = texel * SMALLEST;
    const reaches = (x: number, y: number, z: number, radius: number): boolean => {
      for (let side = 2; side < 6; side++) {
        const plane = sides[side]!;
        if (plane.normal.x * x + plane.normal.y * y + plane.normal.z * z + plane.d < -radius) return false;
      }
      return true;
    };
    const kept = (perCascade[cascade] ??= []);
    kept.length = 0;
    for (let i = 0; i < length; i++) {
      const mesh = list[i]!;
      const groups = groupsOf.get(mesh);
      if (groups) {
        if (groups.size < smallest) continue;
        const s = groups.spheres;
        for (let g = 0; g < s.length; g += 4) {
          if (reaches(s[g]!, s[g + 1]!, s[g + 2]!, s[g + 3]!)) {
            kept.push(mesh);
            break;
          }
        }
        continue;
      }
      const sphere = mesh.getBoundingInfo().boundingSphere;
      if (sphere.radiusWorld < smallest) continue;
      const c = sphere.centerWorld;
      if (reaches(c.x, c.y, c.z, sphere.radiusWorld)) kept.push(mesh);
    }
    return kept;
  };
}
