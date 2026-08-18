// Phase 0 vertical slice — Capture Console fork (KICKOFF §5).
// One vdo.ninja view URL → hidden offscreen BrowserWindow → NDI stream.
// Standalone Electron entry; zero diffs to EC core:
//   node_modules/.bin/electron ./capture/slice-main.js -- \
//     --url="https://vdo.ninja/?view=XXX&noaudio" --ndi-name=DND-SLICE \
//     --width=1920 --height=1080 --fps=30 [--duration=1800] [--probe-shared-texture]
const { app, BrowserWindow } = require('electron');
const ndi = require('./ndi-sender');

function arg(name, dflt) {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : dflt;
}
const URL = arg('url', 'https://vdo.ninja/?view=ccsmoke2026a&noaudio');
const NDI_NAME = arg('ndi-name', 'DND-SLICE');
const WIDTH = parseInt(arg('width', '1920'), 10);
const HEIGHT = parseInt(arg('height', '1080'), 10);
const FPS = parseInt(arg('fps', '30'), 10);
const DURATION_S = parseInt(arg('duration', '0'), 10); // 0 = run until killed
const PROBE_SHARED_TEXTURE = process.argv.includes('--probe-shared-texture');

// The window is hidden for its entire life — Chromium must never throttle it.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Keep OSR output at the requested pixel size regardless of system DPI scale.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
	console.log(`[slice] Electron ${process.versions.electron} | Chromium ${process.versions.chrome} | Node ${process.versions.node}`);
	console.log(`[slice] url=${URL}`);
	console.log(`[slice] ndi=${NDI_NAME} ${WIDTH}x${HEIGHT}@${FPS}${PROBE_SHARED_TEXTURE ? ' (shared-texture probe)' : ''}`);

	const sender = await ndi.create(NDI_NAME, { fps: FPS });

	const win = new BrowserWindow({
		show: false,
		width: WIDTH,
		height: HEIGHT,
		webPreferences: {
			offscreen: PROBE_SHARED_TEXTURE ? { useSharedTexture: true } : true,
			backgroundThrottling: false,
		},
	});
	win.webContents.setFrameRate(FPS);

	let paints = 0, texturePaints = 0, lastLogPaints = 0, lastLogTime = Date.now();
	let firstPaintLogged = false;

	win.webContents.on('paint', (event, dirty, image) => {
		paints++;
		if (event.texture) {
			// Shared-texture mode: GPU handle, no CPU bitmap. Probe only — release and count.
			texturePaints++;
			if (texturePaints === 1) {
				const ti = event.texture.textureInfo;
				console.log(`[slice] SHARED TEXTURE PRESENT: pixelFormat=${ti.pixelFormat} codedSize=${JSON.stringify(ti.codedSize)}`);
			}
			event.texture.release();
			return;
		}
		const size = image.getSize();
		if (!firstPaintLogged) {
			firstPaintLogged = true;
			console.log(`[slice] first paint: ${size.width}x${size.height}`);
		}
		// toBitmap() copies — the paint-owned buffer must not be handed to the async NDI thread.
		sender.sendFrame(image.toBitmap(), size.width, size.height, size.width * 4);
	});

	win.webContents.on('render-process-gone', (e, details) => {
		console.error(`[slice] RENDERER GONE: ${details.reason} (exitCode ${details.exitCode})`);
	});
	win.webContents.on('did-fail-load', (e, code, desc) => {
		console.error(`[slice] LOAD FAILED: ${code} ${desc}`);
	});
	win.webContents.on('did-finish-load', () => console.log('[slice] page loaded'));

	setInterval(() => {
		const now = Date.now();
		const paintFps = (paints - lastLogPaints) / ((now - lastLogTime) / 1000);
		lastLogPaints = paints; lastLogTime = now;
		const s = sender.stats();
		const mem = process.memoryUsage();
		console.log(`[slice] paintFps=${paintFps.toFixed(1)} sent=${s.sent} dropped=${s.dropped} ndiConnections=${sender.connections()} rssMB=${Math.round(mem.rss / 1048576)}`);
	}, 5000);

	if (DURATION_S > 0) {
		setTimeout(async () => {
			console.log(`[slice] duration ${DURATION_S}s reached; shutting down cleanly`);
			try { await sender.destroy(); } catch {}
			app.exit(0);
		}, DURATION_S * 1000);
	}

	await win.loadURL(URL);
}).catch(err => {
	console.error('[slice] FATAL:', err);
	app.exit(1);
});
