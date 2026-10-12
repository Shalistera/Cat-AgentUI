import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

// A deploy replaces the hashed chunks, so a tab opened before it can no longer
// lazy-load one (Mermaid, the NAI tag library). Reload into the new build
// instead of failing — at most once a minute, in case the chunk is really gone.
window.addEventListener('vite:preloadError', (e) => {
  try {
    const last = Number(sessionStorage.getItem('cat-stale-reload')) || 0;
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem('cat-stale-reload', String(Date.now()));
  } catch {
    return; // private mode: without the guard a reload could loop
  }
  e.preventDefault();
  location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
