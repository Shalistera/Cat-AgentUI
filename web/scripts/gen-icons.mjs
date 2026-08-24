// One-off PWA icon generator: rasterizes public/cat.svg into the PNG set the
// manifest and iOS need. The PNGs are committed — this only reruns when the
// logo changes:  node web/scripts/gen-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const cat = fs.readFileSync(path.join(publicDir, 'cat.svg'), 'utf8')
  .replace(/<\/?svg[^>]*>/g, ''); // inner elements only; re-wrapped below

/**
 * The favicon composition: white rounded square, cat at `scale` around the
 * center. Maskable icons shrink the cat further so platform masks (circles,
 * squircles) never clip the ears.
 */
function iconSvg(scale, rounded) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" ${rounded ? 'rx="14"' : ''} fill="#ffffff"/>
  <g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${cat}</g>
</svg>`;
}

function render(svg, size, file) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.writeFileSync(path.join(publicDir, file), png);
  console.log(`${file} (${size}x${size}, ${(png.length / 1024).toFixed(1)} KB)`);
}

render(iconSvg(0.84, true), 192, 'icon-192.png');
render(iconSvg(0.84, true), 512, 'icon-512.png');
render(iconSvg(0.62, false), 512, 'icon-maskable-512.png');
// iOS applies its own corner mask to a full-bleed square.
render(iconSvg(0.78, false), 180, 'apple-touch-icon.png');
