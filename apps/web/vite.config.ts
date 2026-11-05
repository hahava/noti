import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 루트에서 `vite --config apps/web/vite.config.ts` 로 실행해도 이 폴더를 기준으로 삼는다.
const WEB_ROOT = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const API_TARGET = process.env.VITE_API_TARGET || "http://127.0.0.1:4000";
const DEV_HOST = process.env.VITE_DEV_HOST || "127.0.0.1";

export default defineConfig({
  root: WEB_ROOT,
  // .env(VITE_*)는 예전처럼 저장소 루트에서 읽는다.
  envDir: REPO_ROOT,
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: DEV_HOST,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
      },
      "/uploads": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
