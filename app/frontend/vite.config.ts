import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()], // @tailwindcss/vite is Tailwind v4's setup (no postcss)
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5173,
    proxy: {
      "/auth": "http://localhost:3000",
      "/credentials": "http://localhost:3000",
      "/schedule": "http://localhost:3000",
      "/runs": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
  build: { outDir: "dist" },
});
