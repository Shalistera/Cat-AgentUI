// A Content-Security-Policy for model-generated HTML rendered in sandboxed
// iframes (HTML 预览, 工作区 file preview). The iframe already lacks
// allow-same-origin, so scripts can't reach our cookies; this additionally
// stops the page from phoning home with whatever it can see. Inline script
// and style stay allowed (the point of the feature); images/media allow data:
// and blob: only; EVERYTHING that leaves the machine — fetch/XHR/WebSocket
// (connect-src), form posts (form-action), navigation (navigate-to),
// plugins, workers, nested frames — is denied.
const CANVAS_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
].join('; ');

const META = `<meta http-equiv="Content-Security-Policy" content="${CANVAS_CSP}">`;

/** Prepend the CSP meta so it applies before any of the model's own markup
    runs. A meta CSP at the very start of the document is honoured by the
    browser for everything that follows. */
export function withCanvasCsp(html: string): string {
  return `${META}\n${html ?? ''}`;
}
