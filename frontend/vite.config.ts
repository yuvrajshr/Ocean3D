import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The frontend never talks to erddap.incois.gov.in directly — it has no CORS
// headers and an incomplete TLS chain. Everything goes through the FastAPI
// backend, which is proxied here in dev so the app uses same-origin /api paths
// in both development and production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
