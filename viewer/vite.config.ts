import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const API_PORT = process.env.PORT || 4781;

export default defineConfig({
  plugins: [react()],
  publicDir: path.resolve(__dirname, "../output"),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 4782,
    open: true,
    proxy: {
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
    },
  },
});
