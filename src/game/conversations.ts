import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ASSETS } from "../config";
import { spawnModel } from "../engine/assets";
import type { GameContext } from "../engine/context";
import { createDialogue, type Conversation, type Dialogue } from "../engine/dialogue";
import type { MapMarker, StreamedMap } from "../engine/map";
import type { Triggers } from "../engine/triggers";
import type { Hud } from "./hud";
import type { Player } from "./player";

/**
 * People to talk to.
 *
 * Where someone stands and what they say is decided in two places, neither
 * of them here:
 *
 * - **Blender** places them: an Empty with `talk = "steward"` (the story, and
 *   optionally `#knot`), `prompt` and `radius` like anything else that is
 *   used, and `npc = "fox"` if a stand-in character should be put there.
 * - **Ink** says what is said: every `.ink` file in `stories/` is a story,
 *   named after its file. See src/engine/dialogue.ts for what a story can do.
 *
 * This file joins them up: it makes the Empties usable, shows the
 * conversation in the HUD, and gives the keys to it while it lasts (interact
 * or jump for the next line, the number keys to answer). The player stands
 * still but can look around; walking off is not possible, so every story
 * should offer a way to say goodbye.
 */

export interface Conversations {
  readonly dialogue: Dialogue;
  /** Makes the people placed in a map (Empties with `talk`) usable, and stands a character at those with `npc`. */
  followMap(map: StreamedMap): void;
  dispose(): void;
}

// Every story in stories/, compiled by the build. The file's name is the story's.
const STORIES = import.meta.glob<string>("./stories/*.ink", { eager: true, import: "default" });

/** The stand-in for anyone: the sample fox, sitting. Metres from paws to ear tips. */
const STAND_IN = { url: ASSETS.fox, height: 0.75, idle: "Survey" };

export function createConversations(ctx: GameContext, systems: { triggers: Triggers; hud: Hud; player: Player }): Conversations {
  const { scene, input, lighting } = ctx;
  const { triggers, hud, player } = systems;
  const dialogue = createDialogue(ctx.state);
  for (const [path, compiled] of Object.entries(STORIES)) dialogue.add(path.slice(path.lastIndexOf("/") + 1, -".ink".length), compiled);

  let talking: Conversation | null = null;
  /** The frame a conversation begins on still carries the key press that began it. */
  let justBegan = false;
  const standIns: { dispose(): void }[] = [];
  let disposed = false;

  const show = (conversation: Conversation | null): void => {
    if (!conversation?.line) {
      hud.say(null);
      return;
    }
    const answering = conversation.choices.length > 0;
    hud.say({
      speaker: conversation.line.speaker,
      text: conversation.line.text,
      choices: conversation.choices,
      hint: answering ? `Press 1 to ${conversation.choices.length} to answer` : `[ ${input.labelFor("interact")} ]  continue`,
    });
  };
  const changed = dialogue.onChanged.add((conversation) => {
    show(conversation);
    if (conversation) return;
    talking = null;
    player.frozen = false;
    triggers.suspended = false;
  });

  triggers.onInteract("talk", (person) => {
    const story = person.marker?.props.talk;
    if (typeof story !== "string" || talking) return;
    if (!dialogue.has(story.split("#")[0]!)) {
      console.warn(`"${person.marker!.name}" wants to tell the story "${story}", but there is no such file in src/game/stories/.`);
      return;
    }
    player.frozen = true;
    triggers.suspended = true;
    justBegan = true;
    talking = dialogue.start(story);
  });

  const frame = scene.onBeforeRenderObservable.add(() => {
    if (!talking || ctx.clock.paused) return;
    if (justBegan) {
      justBegan = false;
      return;
    }
    if (talking.choices.length > 0) {
      for (let i = 0; i < talking.choices.length && i < 9; i++) {
        if (input.wasKeyPressed(`Digit${i + 1}`) || input.wasKeyPressed(`Numpad${i + 1}`)) {
          talking.choose(i);
          return;
        }
      }
    } else if (input.wasPressed("interact") || input.wasPressed("jump")) {
      talking.continue();
    }
  });

  async function standIn(marker: MapMarker): Promise<void> {
    const model = await spawnModel(scene, STAND_IN.url, `talker-${marker.name}`);
    if (disposed) {
      model.dispose();
      return;
    }
    const bounds = model.root.getHierarchyBoundingVectors();
    const scale = STAND_IN.height / (bounds.max.y - bounds.min.y);
    model.root.scaling.setAll(scale);
    model.root.position.copyFrom(Vector3.FromArray(marker.position)).addInPlaceFromFloats(0, -bounds.min.y * scale, 0);
    model.root.rotation.y = marker.yaw;
    for (const mesh of model.meshes) lighting.addShadowCaster(mesh);
    model.animations.get(STAND_IN.idle)?.start(true);
    standIns.push(model);
  }

  return {
    dialogue,
    followMap(map) {
      for (const marker of map.manifest.markers) {
        if (typeof marker.props.talk !== "string") continue;
        triggers.addInteractable({
          name: "talk",
          at: Vector3.FromArray(marker.position).addInPlaceFromFloats(0, 0.5, 0),
          prompt: typeof marker.props.prompt === "string" ? marker.props.prompt : "Talk",
          radius: typeof marker.props.radius === "number" ? marker.props.radius : 2.4,
          marker,
        });
        if (marker.props.npc) void standIn(marker).catch((error) => console.warn(`Could not stand anyone at "${marker.name}":`, error));
      }
    },
    dispose() {
      disposed = true;
      dialogue.onChanged.remove(changed);
      scene.onBeforeRenderObservable.remove(frame);
      talking?.end();
      hud.say(null);
      for (const model of standIns) model.dispose();
    },
  };
}
