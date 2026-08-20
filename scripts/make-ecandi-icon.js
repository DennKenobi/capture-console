// ECANDI icon builder — Session 10. Renders assets/ecandi-logo-bg.svg (Dennis's
// Just-Create-Studios-derived mark) to PNGs with Electron's own renderer and
// assembles a multi-size assets/ecandi.ico. No external tooling: modern ICO
// containers accept PNG-compressed entries (Vista+), so the file is just
// ICONDIR + one ICONDIRENTRY per size + the raw PNG blobs.
//
//   node_modules\electron\dist\electron.exe scripts\make-ecandi-icon.js
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// Without this, offscreen paints happen at system DPI scale, not the requested
// pixel size (same lesson as capture/slice-main.js).
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

// The ECANDI mark (Dennis, 2026-08-20): hex + bolt only — the Just Create
// Labs family identity, simplified for small sizes by design. Both variants
// already carry the hex-interior ground (#0a0f1f) on an 800-unit canvas, so
// corners stay transparent (hex-shaped icon) with no injection needed.
// Dennis's split: the baked-glow mark for larger sizes, the plain mark for
// small ones (glow at tiny sizes just reads as blur).
const SVG_GLOW = path.resolve(__dirname, '..', 'assets', 'ecandi-mark-glow.svg');
const SVG_PLAIN = path.resolve(__dirname, '..', 'assets', 'ecandi-mark.svg');
const OUT_PATH = path.resolve(__dirname, '..', 'assets', 'ecandi.ico');
const SIZES = [16, 32, 48, 64, 128, 256];
const GLOW_MIN_SIZE = 64; // glow variant at and above this size
function svgForSize(size) {
	return size >= GLOW_MIN_SIZE ? SVG_GLOW : SVG_PLAIN;
}

// ONE reused offscreen window, resized per capture — destroying an offscreen
// window mid-run breaks subsequent loads in this runtime (the Session 5
// destroy-wedge class; measured here as ERR_FAILED on the next loadFile).
// The SVG loads as the top-level document: viewBox-only SVGs fill the
// viewport and rescale on resize. (A file:// img inside a data: page never
// loads — file subresources are blocked from non-file origins — measured.)
// Windows clamps even frameless windows to a minimum size — a 16×16 request
// renders larger and capturePage'd a corner fragment (caught on the compare
// sheet; the first shipped ico's 16 px entry had this). Render at ≥64 px and
// downscale: the stroke boost is canvas-relative, so it lands at the same
// device-pixel weight either way.
const MIN_RENDER = 64;
let renderWin = null;
async function renderSize(size) {
	const renderAt = Math.max(size, MIN_RENDER);
	if (!renderWin) {
		renderWin = new BrowserWindow({
			show: false,
			width: renderAt,
			height: renderAt,
			useContentSize: true,
			frame: false,
			transparent: true, // corners outside the hex stay alpha-0
			webPreferences: { offscreen: true },
		});
	} else {
		renderWin.setContentSize(renderAt, renderAt);
	}
	// loadFile into the SAME window per size (reload-in-place — never destroy):
	// small sizes get their stroke-boosted variant, large ones the original.
	await renderWin.loadFile(svgForSize(size));
	await new Promise(r => setTimeout(r, 400)); // let the SVG (incl. its glow filter) paint
	const img = await renderWin.webContents.capturePage({ x: 0, y: 0, width: renderAt, height: renderAt });
	return img.resize({ width: size, height: size }).toPNG();
}

function buildIco(pngs) {
	const count = pngs.length;
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0); // reserved
	header.writeUInt16LE(1, 2); // type: icon
	header.writeUInt16LE(count, 4);
	let offset = 6 + 16 * count;
	const entries = [];
	for (const { size, data } of pngs) {
		const e = Buffer.alloc(16);
		e.writeUInt8(size === 256 ? 0 : size, 0); // 0 = 256
		e.writeUInt8(size === 256 ? 0 : size, 1);
		e.writeUInt16LE(1, 4);  // color planes
		e.writeUInt16LE(32, 6); // bits per pixel
		e.writeUInt32LE(data.length, 8);
		e.writeUInt32LE(offset, 12);
		offset += data.length;
		entries.push(e);
	}
	return Buffer.concat([header, ...entries, ...pngs.map(p => p.data)]);
}

app.whenReady().then(async () => {
	if (!fs.existsSync(SVG_GLOW) || !fs.existsSync(SVG_PLAIN)) {
		console.error(`missing ${SVG_GLOW} or ${SVG_PLAIN}`);
		app.exit(2);
		return;
	}
	const pngs = [];
	for (const size of SIZES) {
		const data = await renderSize(size);
		pngs.push({ size, data });
		console.log(`rendered ${size}x${size} (${data.length} bytes)`);
	}
	fs.writeFileSync(OUT_PATH, buildIco(pngs));
	console.log(`wrote ${OUT_PATH} (${fs.statSync(OUT_PATH).size} bytes, ${SIZES.length} sizes)`);
	app.exit(0);
}).catch(err => {
	console.error('FATAL:', err);
	app.exit(1);
});
