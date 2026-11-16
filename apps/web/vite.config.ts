import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 루트에서 `vite --config apps/web/vite.config.ts` 로 실행해도 이 폴더를 기준으로 삼는다.
const WEB_ROOT = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const API_TARGET = process.env.VITE_API_TARGET || "http://127.0.0.1:4000";
const DEV_HOST = process.env.VITE_DEV_HOST || "127.0.0.1";

// SVAR Gantt CSS 는 cdn.svar.dev 폰트를 불러온다. 외부 요청·Electron CSP 위반을 막으려 @font-face 를 빼고 Noty 글꼴을 쓴다.
const stripSvarFonts = {
  name: "noty-strip-svar-fonts",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!id.includes("@svar-ui/") || !id.split("?")[0].endsWith(".css")) return null;
    return { code: code.replace(/@font-face\s*\{[^}]*\}/g, ""), map: null };
  },
};

export default defineConfig({
  root: WEB_ROOT,
  // .env(VITE_*)는 예전처럼 저장소 루트에서 읽는다.
  envDir: REPO_ROOT,
  plugins: [stripSvarFonts, react()],
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
