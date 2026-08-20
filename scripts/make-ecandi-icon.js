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

const SVG_PATH = path.resolve(__dirname, '..', 'assets', 'ecandi-logo.svg');
const OUT_PATH = path.resolve(__dirname, '..', 'assets', 'ecandi.ico');
const SIZES = [16, 32, 48, 64, 128, 256];

// The icon ground fills only the INSIDE of the purple hexagon (Dennis,
// 2026-08-20) — corners stay transparent, so the desktop icon is hex-shaped.
// Vertices read off the Purple ring path's outer contour (900-unit canvas);
// the ring paints over the polygon edge, hiding any AA seam. Color is the
// with-BG SVG's top layer (CyberSec_Drk_Bl_1).
const HEX_BG = '<polygon points="450.94,64.37 784.73,257.32 784.73,642.68 '
	+ '450.94,835.63 116.87,642.68 116.87,257.32" fill="#0a0f1f"/>';

// Per-size variants (icon craft, not artwork changes): the source SVG draws on
// a 900-unit canvas with 5-unit strokes — at 48 px that renders 0.27 px and
// the camera dissolves. For small sizes a CSS override (injected into a temp
// copy; CSS beats presentation attributes) rescales strokes to ~1.5 device px
// and outlines the thin FILLED shapes (tripod legs, bolt) the same way. At
// 16 px the tripod is three hairlines across five pixels — dropped entirely.
const TWEAK_MAX_SIZE = 64;      // stroke boost applies at and below this size
const CAMERA_TARGET_PX = 1.5;   // camera-body stroke, in device pixels
const AUX_TARGET_PX = 0.9;      // added outline on legs/bolt fills
function svgForSize(size) {
	let css = '';
	if (size <= TWEAK_MAX_SIZE) {
		const cam = Math.round(CAMERA_TARGET_PX * 900 / size);
		const aux = Math.round(AUX_TARGET_PX * 900 / size);
		css = '<style>'
			+ `#Movie_Cam_Body{stroke-width:${cam}px}`
			+ `#Movie_Cam_Legs,#Lightning_Bolt polygon{stroke:#00e0e9;stroke-width:${aux}px;paint-order:stroke}`
			+ (size <= 16 ? '#Movie_Cam_Legs{display:none}' : '')
			+ '</style>';
	}
	// hex ground first in document order = behind the ring and the camera art
	const text = fs.readFileSync(SVG_PATH, 'utf8')
		.replace('<g id="symbol_only">', css + HEX_BG + '<g id="symbol_only">');
	const tmp = path.join(require('os').tmpdir(), `ecandi-icon-${size}.svg`);
	fs.writeFileSync(tmp, text);
	return tmp;
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
	if (!fs.existsSync(SVG_PATH)) {
		console.error(`missing ${SVG_PATH}`);
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
