import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 后台管理界面的构建配置。
//
// - base 固定为 /admin/：产物由 src/server.mjs 直接托管，不走单独的前端服务；
// - dev 时把 /admin/api、/v1、/healthz 代理到正在跑的本体服务，改前端不用重启后端。
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      '/admin/api': 'http://127.0.0.1:8787',
      '/v1': 'http://127.0.0.1:8787',
      '/healthz': 'http://127.0.0.1:8787',
    },
  },
});
