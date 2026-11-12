import { defineConfig } from "vite";

/** The game (game.html): a static build with relative URLs, so it runs from any folder or host. */
export default defineConfig({
  base: "./",
  publicDir: false,
  worker: { format: "es" },
  build: { target: "es2022", outDir: "dist-game", emptyOutDir: true, rollupOptions: { input: "game.html" } },
  server: { host: "127.0.0.1", port: 5327, strictPort: true },
  preview: { host: "127.0.0.1", port: 5328, strictPort: true },
});
