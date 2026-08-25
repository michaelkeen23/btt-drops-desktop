// Builds assets/icon.ico + assets/tray.png from assets/icon.png (the 512px BTT Drops tile, the same art
// the web app's PWA icons use). Self-contained: pngjs for decode/encode, a box filter for the downscale,
// png-to-ico to assemble the multi-size .ico Windows wants for the taskbar/tray/installer.
//
//   node scripts/make-icons.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const pngToIco = require("png-to-ico");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "assets");
const SRC = path.join(ASSETS, "icon.png");
const PNGDIR = path.join(ASSETS, "png");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

if (!fs.existsSync(SRC)) { console.error("missing assets/icon.png"); process.exit(1); }

// Area-average downscale — a nearest-neighbour shrink turns the tile's text into noise at 16px.
function resize(src, size) {
  const out = new PNG({ width: size, height: size });
  const sx = src.width / size, sy = src.height / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < src.height; yy++) {
        for (let xx = x0; xx < x1 && xx < src.width; xx++) {
          const i = (src.width * yy + xx) << 2;
          r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; a += src.data[i + 3]; n++;
        }
      }
      const o = (size * y + x) << 2;
      out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = a / n;
    }
  }
  return out;
}

const src = PNG.sync.read(fs.readFileSync(SRC));
fs.mkdirSync(PNGDIR, { recursive: true });
const files = [];
for (const s of SIZES) {
  const f = path.join(PNGDIR, `icon-${s}.png`);
  fs.writeFileSync(f, PNG.sync.write(resize(src, s)));
  files.push(f);
}
fs.writeFileSync(path.join(ASSETS, "tray.png"), fs.readFileSync(path.join(PNGDIR, "icon-32.png")));
const ico = await pngToIco(files);
fs.writeFileSync(path.join(ASSETS, "icon.ico"), ico);
console.log(`wrote assets/icon.ico (${SIZES.length} sizes, ${(ico.length / 1024).toFixed(0)} KB) + assets/tray.png`);
