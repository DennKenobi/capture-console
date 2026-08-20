// Authoring-time generator for the NSIS installer sidebar (Session 11 Part B).
// electron-builder wants a 164x314 BMP; without one the installer shows
// electron-builder's stock blue "download" graphic, which reads as a generic
// Electron app rather than ECANDI. Same pattern as make-ecandi-icon.js: render
// with Electron offscreen, hand-write the container format.
//
//   node scripts/make-ecandi-sidebar.js
//
// Gotchas inherited from make-ecandi-icon.js (Session 10 — do not re-learn):
// a file:// <img> inside a data: page never loads (blocked cross-origin), so
// the SVG is inlined; and Windows clamps even frameless windows to a minimum
// size, so render large and downscale rather than requesting 164x314 directly.
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const W = 164, H = 314;
const SCALE = 3; // render at 492x942, downscale — dodges the min-size clamp
// assets/, not build/ — build/ is gitignored and this is a checked-in brand
// asset like assets/ecandi.ico, not a build output.
const OUT = path.join(__dirname, '..', 'assets', 'ecandi-sidebar.bmp');
const markSvg = fs.readFileSync(path.join(__dirname, '..', 'assets', 'ecandi-mark-glow.svg'), 'utf8');

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${W * SCALE}px;height:${H * SCALE}px;overflow:hidden}
  body{
    background:
      radial-gradient(120% 60% at 20% 8%, rgba(120,86,255,.34), transparent 60%),
      radial-gradient(120% 55% at 85% 96%, rgba(0,224,233,.26), transparent 62%),
      #0a0f1f;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    font-family:"Segoe UI",system-ui,sans-serif;
  }
  .mark{width:${58 * SCALE}px;height:${58 * SCALE}px;margin-bottom:${18 * SCALE}px}
  .mark svg{width:100%;height:100%;display:block}
  .word{
    font-size:${17 * SCALE}px; font-weight:700; letter-spacing:${2.5 * SCALE}px;
    color:#e7e9ea; text-shadow:0 0 ${6 * SCALE}px rgba(0,224,233,.55);
  }
  .sub{
    margin-top:${7 * SCALE}px; font-size:${7.5 * SCALE}px; letter-spacing:${0.7 * SCALE}px;
    color:#8b98a5; text-transform:uppercase; text-align:center; line-height:1.7;
  }
</style></head><body>
  <div class="mark">${markSvg}</div>
  <div class="word">ECANDI</div>
  <div class="sub">NDI capture<br>console</div>
</body></html>`;

/** 24-bit BMP: bottom-up rows, each padded to a 4-byte boundary.
 *  nativeImage.toBitmap() hands back **BGRA**, which is already the channel
 *  order BMP wants — copying it straight through is correct; treating it as
 *  RGBA and "converting" swaps red and blue (the first run of this script came
 *  out yellow-and-red instead of cyan-and-purple). */
function encodeBmp(bgra, w, h) {
	const rowBytes = w * 3;
	const pad = (4 - (rowBytes % 4)) % 4;
	const pixels = Buffer.alloc((rowBytes + pad) * h);
	let o = 0;
	for (let y = h - 1; y >= 0; y--) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			pixels[o++] = bgra[i];
			pixels[o++] = bgra[i + 1];
			pixels[o++] = bgra[i + 2];
		}
		o += pad;
	}
	const header = Buffer.alloc(54);
	header.write('BM', 0);
	header.writeUInt32LE(54 + pixels.length, 2);
	header.writeUInt32LE(54, 10);
	header.writeUInt32LE(40, 14);
	header.writeInt32LE(w, 18);
	header.writeInt32LE(h, 22);
	header.writeUInt16LE(1, 26);
	header.writeUInt16LE(24, 28);
	header.writeUInt32LE(pixels.length, 34);
	return Buffer.concat([header, pixels]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
	const win = new BrowserWindow({
		width: W * SCALE, height: H * SCALE, show: false, frame: false,
		webPreferences: { offscreen: true, backgroundThrottling: false },
	});
	await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
	await new Promise(r => setTimeout(r, 600));
	const img = await win.webContents.capturePage();
	const small = img.resize({ width: W, height: H, quality: 'best' });
	const { width, height } = small.getSize();
	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	fs.writeFileSync(OUT, encodeBmp(small.toBitmap(), width, height));
	console.log(`wrote ${OUT} (${width}x${height})`);
	app.exit(0);
});
