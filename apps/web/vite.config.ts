import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "VITE_");
  const hostOrigin = env.VITE_HOST_ORIGIN || "http://127.0.0.1:4317";

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target: hostOrigin,
          changeOrigin: false,
        },
      },
    },
    build: {
      sourcemap: false,
    },
  };
});
