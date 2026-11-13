#!/usr/bin/env node
// Runs the Blender map tools without needing to know where Blender lives.
//
//   npm run map:export -- maps/my_map.blend [--chunk 64] [--no-lod] [--draco] [--no-ktx2] ...
//       -> public/maps/my_map/   (override with --out <dir>)
//   npm run map:make-test
//       -> maps/test_island.blend, then exports it
//   npm run map:make-town
//       -> maps/test_town.blend, then exports it (in 32 m chunks)
//
// Set BLENDER=/path/to/blender if it isn't found automatically.
//
// The exporter calls back into this script for the one step that runs in Node
// rather than Blender:
//
//   node tools/map.mjs encode-textures <jobs.json>
//       -> compresses a map's textures to KTX2 with Babylon's encoder, and keeps
//          a copy of the matching decoder in public/babylon/ktx2/ for the game.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function findBlender() {
  const candidates = [process.env.BLENDER, "/Applications/Blender.app/Contents/MacOS/Blender"];
  const windows = "C:\\Program Files\\Blender Foundation";
  if (existsSync(windows)) {
    for (const dir of readdirSync(windows).sort().reverse()) candidates.push(join(windows, dir, "blender.exe"));
  }
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return "blender"; // hope it's on PATH (typical on Linux)
}

function blender(args) {
  const result = spawnSync(findBlender(), ["-b", ...args], {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    maxBuffer: Infinity,
    env: { ...process.env, NODE: process.execPath }, // the exporter runs `encode-textures` with this same Node
  });
  if (result.error) {
    console.error(`Could not run Blender (${result.error.message}). Install it or set BLENDER=/path/to/blender.`);
    process.exit(1);
  }
  // Blender is chatty; show only our scripts' own lines and anything that went wrong.
  for (const line of result.stdout.split("\n")) {
    if (/^\[(export_map|make_test_map|make_test_town)\]|Error|Traceback|^\s+File "/.test(line)) console.log(line);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function exportMap(blendFile, extra) {
  const args = [...extra];
  if (!args.includes("--out")) args.push("--out", join(root, "public", "maps", basename(blendFile, extname(blendFile))));
  blender([resolve(blendFile), "--python", join(root, "tools", "blender", "export_map.py"), "--", ...args]);
}

// --- KTX2 textures -----------------------------------------------------------

/**
 * The game decodes KTX2 textures with Babylon's decoder, which Babylon would
 * otherwise download from its CDN while the game runs. Keep a copy under
 * public/ instead (src/engine/map.ts points Babylon at it): the transcoders as
 * they ship in @babylonjs/ktx2decoder, plus the decoder itself bundled into
 * the one plain script that Babylon's worker threads load.
 */
async function provideDecoder() {
  const entry = require.resolve("@babylonjs/ktx2decoder");
  const { version } = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8"));
  const target = join(root, "public", "babylon", "ktx2");
  const stamp = join(target, "version.txt");
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === version) return;

  mkdirSync(target, { recursive: true });
  const transcoders = join(dirname(entry), "wasm");
  for (const file of readdirSync(transcoders)) copyFileSync(join(transcoders, file), join(target, file));
  const { build } = await import("vite");
  await build({
    root,
    configFile: false,
    logLevel: "error",
    publicDir: false,
    build: {
      outDir: target,
      emptyOutDir: false,
      lib: { entry, formats: ["iife"], name: "KTX2DECODER", fileName: () => "babylon.ktx2Decoder.js" },
    },
  });
  writeFileSync(stamp, `${version}\n`);
  console.log(`[export_map] KTX2 decoder ${version} copied to public/babylon/ktx2/`);
}

/**
 * Compresses one texture with the Basis Universal encoder that ships in
 * `@babylonjs/ktx2encoder`. The package's own `KTX2Encoder` class offers two
 * recipes, compact for colour and high-fidelity for everything else; the
 * second makes a roughness map as large as a normal map (1.3 MB at 1024 px),
 * so this drives the encoder directly and adds a third:
 *
 *   "color"   ETC1S, sRGB. Compact (about 0.2 MB at 1024 px).
 *   "data"    ETC1S, linear: roughness, metalness, occlusion. These are
 *             smooth, forgiving maps, and it makes them an eighth the size.
 *   "normal"  UASTC with the encoder's normal-map settings. The compact
 *             format visibly damages normals, so they stay high-fidelity and
 *             the exporter stores them smaller instead (--normal-scale).
 *
 * All get a full set of mipmaps.
 */
function encodeTexture(basis, rgba, width, height, usage, quality) {
  const encoder = new basis.BasisEncoder();
  try {
    const srgb = usage === "color";
    const compact = usage !== "normal";
    if (usage === "normal") encoder.setNormalMapPreset();
    encoder.setCreateKTX2File(true);
    encoder.setTexType(basis.basis_texture_type.cBASISTexType2D.value);
    encoder.setFormatMode((compact ? basis.basis_tex_format.cETC1S : basis.basis_tex_format.cUASTC_LDR_4x4).value);
    encoder.setPerceptual(srgb);
    encoder.setMipSRGB(srgb);
    encoder.setKTX2AndBasisSRGBTransferFunc(srgb);
    encoder.setMipGen(true);
    if (compact) {
      encoder.setQualityLevel(quality ?? 128);
      encoder.setETC1SCompressionLevel(2);
    } else {
      encoder.setPackUASTCFlags(2);
      encoder.setKTX2UASTCSupercompression(true); // Zstandard
    }
    if (!encoder.setSliceSourceImage(0, rgba, width, height, 0)) throw new Error(`the encoder rejected a ${width}x${height} image`);
    const output = new Uint8Array(rgba.byteLength + 65536);
    const length = encoder.encode(output);
    if (length === 0) throw new Error(`the encoder failed on a ${width}x${height} ${usage} texture`);
    const ktx2 = output.slice(0, length);
    if (!srgb) {
      // Mark the file as plain numbers rather than colours in a colour space, as Babylon's own encoder does.
      const view = new DataView(ktx2.buffer);
      ktx2[view.getUint32(48, true) + 13] = 0;
    }
    return ktx2;
  } finally {
    encoder.delete();
  }
}

/**
 * Compresses textures for export_map.py, which hands over raw 8-bit RGBA
 * pixels (top row first): [{ rgba, width, height, usage, quality, out }, ...].
 */
async function encodeTextures(jobFile) {
  const { default: factory } = await import("@babylonjs/ktx2encoder/wasm/basis_encoder.js");
  await provideDecoder();

  const wasmBinary = new Uint8Array(readFileSync(require.resolve("@babylonjs/ktx2encoder/wasm/basis_encoder.wasm"))).buffer;
  const basis = await factory({ wasmBinary, print: () => {} }); // or the codec narrates every mip level
  basis.initializeBasis();
  for (const job of JSON.parse(readFileSync(jobFile, "utf8"))) {
    const started = performance.now();
    const ktx2 = encodeTexture(basis, new Uint8Array(readFileSync(job.rgba)), job.width, job.height, job.usage, job.quality);
    // Written under another name first: a file with the final name is taken as finished by later exports.
    writeFileSync(`${job.out}.part`, ktx2);
    renameSync(`${job.out}.part`, job.out);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(`[export_map] ${basename(job.out)}: ${job.width}x${job.height} ${job.usage}, ${Math.round(ktx2.byteLength / 1024)} KB (${seconds}s)`);
  }
}

// --- Commands ----------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
if (command === "export" && rest[0]) {
  exportMap(rest[0], rest.slice(1));
} else if (command === "make-test") {
  const blendFile = join(root, "maps", "test_island.blend");
  blender(["--factory-startup", "--python", join(root, "tools", "blender", "make_test_map.py"), "--", blendFile]);
  exportMap(blendFile, rest);
} else if (command === "make-town") {
  const blendFile = join(root, "maps", "test_town.blend");
  blender(["--factory-startup", "--python", join(root, "tools", "blender", "make_test_town.py"), "--", blendFile]);
  // A town is dense, so smaller chunks than the default keep each one light.
  exportMap(blendFile, rest.includes("--chunk") ? rest : ["--chunk", "32", ...rest]);
} else if (command === "encode-textures" && rest[0]) {
  try {
    await encodeTextures(rest[0]);
  } catch (error) {
    const missing = error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND";
    console.log(`[export_map] KTX2 encoding failed: ${missing ? "Babylon's KTX2 packages are not installed (run `npm install`)" : error.message}`);
    process.exit(1);
  }
} else {
  console.error("usage:\n  node tools/map.mjs export <file.blend> [export options]\n  node tools/map.mjs make-test\n  node tools/map.mjs make-town");
  process.exit(1);
}
