import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const packageInfo = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

function buildRevision(): string {
  const configured = process.env.APP_REVISION?.trim();
  if (configured) return configured.slice(0, 40);
  try {
    const revision = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return `${revision}${dirty ? '-dirty' : ''}`;
  } catch {
    return 'unknown';
  }
}

// Set DEV_PROXY_HOST when the dev server sits behind a TLS reverse proxy
// (`DEV_PROXY_HOST=dev.example.com npm run dev`). Vite otherwise rejects the
// proxied Host header, and the HMR socket would try to reach the origin port
// directly instead of coming back through the proxy on 443.
const proxyHost = process.env.DEV_PROXY_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION?.trim() || packageInfo.version),
    __APP_REVISION__: JSON.stringify(buildRevision()),
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
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
