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

const SVG_PATH = path.resolve(__dirname, '..', 'assets', 'ecandi-logo-bg.svg');
const OUT_PATH = path.resolve(__dirname, '..', 'assets', 'ecandi.ico');
const SIZES = [16, 32, 48, 64, 128, 256];

// ONE reused offscreen window, resized per capture — destroying an offscreen
// window mid-run breaks subsequent loads in this runtime (the Session 5
// destroy-wedge class; measured here as ERR_FAILED on the next loadFile).
// The SVG loads as the top-level document: viewBox-only SVGs fill the
// viewport and rescale on resize. (A file:// img inside a data: page never
// loads — file subresources are blocked from non-file origins — measured.)
let renderWin = null;
async function renderSize(size) {
	if (!renderWin) {
		renderWin = new BrowserWindow({
			show: false,
			width: size,
			height: size,
			useContentSize: true,
			frame: false,
			webPreferences: { offscreen: true },
		});
		await renderWin.loadFile(SVG_PATH);
	} else {
		renderWin.setContentSize(size, size);
	}
	await new Promise(r => setTimeout(r, 400)); // let the SVG (incl. its glow filter) paint
	const img = await renderWin.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
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
