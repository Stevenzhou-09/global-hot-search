import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    // Dev only: proxy API calls to the standalone server (npm start).
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
