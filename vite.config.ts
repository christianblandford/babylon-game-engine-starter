import { defineConfig } from "vite";

export default defineConfig({
  // Havok ships its own WASM loader; pre-bundling it breaks the .wasm lookup.
  optimizeDeps: { exclude: ["@babylonjs/havok"] },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 6000,
  },
});
