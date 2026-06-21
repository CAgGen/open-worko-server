import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/admin": "http://localhost:8080",
      "/messages": "http://localhost:8080",
      "/context": "http://localhost:8080",
      "/agents": "http://localhost:8080",
      "/inbox": "http://localhost:8080",
      "/threads": "http://localhost:8080",
      "/rooms": "http://localhost:8080",
      "/health": "http://localhost:8080",
    },
  },
});
