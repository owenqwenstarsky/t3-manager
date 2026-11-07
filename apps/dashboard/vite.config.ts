import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/web", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8080" } },
});
