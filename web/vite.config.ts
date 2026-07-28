import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Set DEV_PROXY_HOST when the dev server sits behind a TLS reverse proxy
// (`DEV_PROXY_HOST=dev.example.com npm run dev`). Vite otherwise rejects the
// proxied Host header, and the HMR socket would try to reach the origin port
// directly instead of coming back through the proxy on 443.
const proxyHost = process.env.DEV_PROXY_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000' },
    },
    ...(proxyHost ? {
      allowedHosts: [proxyHost],
      hmr: { host: proxyHost, protocol: 'wss', clientPort: 443 },
    } : {}),
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
});
