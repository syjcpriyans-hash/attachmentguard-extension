import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        editor: resolve(__dirname, "editor.html"),
        sidepanel: resolve(__dirname, "sidepanel.html"),
      },
    },
  },
});
