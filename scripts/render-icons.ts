// Renders the icon PNGs in public/icons/ from the SVGs in icons/, using
// headless Chrome and macOS `sips` so no image library is needed. The icon is
// frozen once the app is installed (SPEC.md, Build and identity), so this
// runs by hand, and only before the first install:
//
//   node scripts/render-icons.ts [path to Chrome]

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
const chrome = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Output file, source SVG, and size in pixels. */
const ICONS: [string, string, number][] = [
  ['apple-touch-icon.png', 'icon.svg', 180],
  ['icon-192.png', 'icon.svg', 192],
  ['icon-512.png', 'icon.svg', 512],
  ['icon-maskable-512.png', 'icon-maskable.svg', 512],
];

if (!existsSync(chrome)) {
  console.error(`Chrome not found at ${chrome}; pass its path as the first argument.`);
  process.exit(1);
}

// Headless Chrome renders a blank page in a window narrower than about 500 px,
// so each SVG is drawn once at this size and scaled down.
const RENDER = 1024;
const tmp = mkdtempSync(join(tmpdir(), 'corvus-icons-'));

function render(svg: string): string {
  const png = join(tmp, svg.replace(/\.svg$/u, '.png'));
  if (!existsSync(png)) {
    // An SVG with only a viewBox fills the window.
    execFileSync(chrome, [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${RENDER},${RENDER}`,
      `--screenshot=${png}`,
      pathToFileURL(join(root, 'icons', svg)).href,
    ], { stdio: 'ignore' });
  }
  return png;
}

try {
  for (const [out, svg, size] of ICONS) {
    const dest = join(root, 'public/icons', out);
    execFileSync('sips', ['-z', String(size), String(size), render(svg), '--out', dest], { stdio: 'ignore' });
    console.log(`public/icons/${out} (${size} px)`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
