import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const ADMIN_API = process.env.ADMIN_API_TARGET || `http://127.0.0.1:${process.env.ADMIN_PORT || 4010}`;

// 어드민 화면: 개발 중에는 5180 포트, /api 는 어드민 서버(4010)로 넘긴다.
// 빌드 결과(web/dist)는 어드민 서버가 같은 포트에서 제공한다.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  base: "/",
  server: {
    host: process.env.ADMIN_WEB_HOST || "127.0.0.1",
    port: Number(process.env.ADMIN_WEB_PORT || 5180),
    strictPort: true,
    proxy: {
      "/api": { target: ADMIN_API, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
