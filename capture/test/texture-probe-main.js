// Session 6 verify-early probe — shared-texture → native module, in the custom runtime.
//   node_modules/.bin/electron ./capture/test/texture-probe-main.js -- \
//     --mode=open|send [--ndi-name=CC-TEXPROBE] [--width=1920] [--height=1080]
//     [--fps=30] [--duration=s]
//
// mode=open  (verify step 1): first paint → dump the textureInfo shape, call
//            native probeOpen() on the real handle, print the D3D11 desc, exit.
//            Exit 0 = the module loads in this runtime AND can open a real
//            paint-event handle. Exit 5 = contract mismatch (documented dump).
// mode=send  (verify step 2): full native path — every paint's texture handed to
//            ndi-native-sender, stats every 5 s. Validate externally with
//            capture/ndi-probe.js (>=29 fps animated at 1080p30).
//
// The page is a self-contained animated canvas (data: URL) — every frame differs,
// no publisher or network needed; paints are paced by setFrameRate.
'use strict';

const { app, BrowserWindow } = require('electron');

function arg(name, dflt) {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : dflt;
}
const MODE = arg('mode', 'open');
const NDI_NAME = arg('ndi-name', 'CC-TEXPROBE');
const WIDTH = parseInt(arg('width', '1920'), 10);
const HEIGHT = parseInt(arg('height', '1080'), 10);
const FPS = parseInt(arg('fps', '30'), 10);
const DURATION_S = parseInt(arg('duration', '0'), 10);

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const PAGE = `<!doctype html><html><body style="margin:0;overflow:hidden;background:#000">
<canvas id="c"></canvas><script>
const c = document.getElementById('c'), x = c.getContext('2d');
c.width = innerWidth; c.height = innerHeight;
let f = 0;
(function loop() {
  f++;
  const g = x.createLinearGradient(0, 0, c.width, c.height);
  g.addColorStop(0, 'hsl(' + (f % 360) + ',80%,30%)');
  g.addColorStop(1, 'hsl(' + ((f + 120) % 360) + ',80%,15%)');
  x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
  const bx = (f * 7) % (c.width + 200) - 100;
  x.fillStyle = '#fff'; x.fillRect(bx, c.height * 0.4, 120, c.height * 0.2);
  x.font = '48px monospace'; x.fillStyle = '#0f0';
  x.fillText('frame ' + f + ' @ ' + Date.now(), 40, 80);
  requestAnimationFrame(loop);
})();
</script></body></html>`;

function handleBufferOf(ti) {
	// 43.3.0 d.ts contract: textureInfo.handle.ntHandle (Buffer). Older builds used
	// textureInfo.sharedTextureHandle. Tolerate both, report which.
	if (ti.handle && ti.handle.ntHandle) return { buf: ti.handle.ntHandle, field: 'handle.ntHandle' };
	if (ti.sharedTextureHandle) return { buf: ti.sharedTextureHandle, field: 'sharedTextureHandle' };
	return { buf: null, field: null };
}

app.whenReady().then(async () => {
	console.log(`[texprobe] Electron ${process.versions.electron} | mode=${MODE} ${WIDTH}x${HEIGHT}@${FPS}`);

	const nts = require('../../native-modules/ndi-texture-send');
	console.log(`[texprobe] native module available=${nts.available}${nts.available ? '' : ' loadError=' + nts.loadError.message}`);
	if (!nts.available) app.exit(5);

	let sender = null;
	if (MODE === 'send') {
		sender = await require('../ndi-native-sender').create(NDI_NAME, { fps: FPS, depth: 2 });
		console.log(`[texprobe] native sender up: ${NDI_NAME}`);
	}

	const win = new BrowserWindow({
		show: false,
		width: WIDTH,
		height: HEIGHT,
		webPreferences: { offscreen: { useSharedTexture: true }, backgroundThrottling: false },
	});
	win.webContents.setFrameRate(FPS);

	let paints = 0, sentOk = 0, droppedBusy = 0, failed = 0, noTexture = 0;
	let lastPaints = 0, lastTime = Date.now();
	let probed = false;

	win.webContents.on('paint', (event, dirty, image) => {
		paints++;
		const tex = event.texture;
		if (!tex) { noTexture++; return; }
		const ti = tex.textureInfo;

		if (!probed) {
			probed = true;
			console.log(`[texprobe] texture keys: ${Object.keys(tex).join(',')}`);
			console.log(`[texprobe] textureInfo keys: ${Object.keys(ti).join(',')}`);
			console.log(`[texprobe] pixelFormat=${ti.pixelFormat} widgetType=${ti.widgetType} codedSize=${JSON.stringify(ti.codedSize)} visibleRect=${JSON.stringify(ti.visibleRect)} contentRect=${JSON.stringify(ti.contentRect)}`);
			const { buf, field } = handleBufferOf(ti);
			console.log(`[texprobe] handle field: ${field || 'MISSING'}${buf ? ` (Buffer ${buf.length} bytes)` : ''}${ti.handle ? ' handle keys: ' + Object.keys(ti.handle).join(',') : ''}`);
			if (MODE === 'open') {
				let code = 0;
				if (!buf) {
					console.error('[texprobe] CONTRACT MISMATCH: no NT handle buffer on textureInfo — dump above is the record');
					code = 5;
				} else {
					try {
						const desc = nts.probeOpen(buf);
						console.log(`[texprobe] PROBE OPEN OK: D3D11 desc ${desc.width}x${desc.height} dxgiFormat=${desc.dxgiFormat}`);
					} catch (err) {
						console.error(`[texprobe] PROBE OPEN FAILED: ${err.message}`);
						code = 5;
					}
				}
				tex.release();
				app.exit(code);
				return;
			}
		}

		if (MODE === 'send' && sender) {
			const { buf } = handleBufferOf(ti);
			let r = -1;
			try {
				if (buf) r = sender.sendTexture(buf, ti.visibleRect ? ti.visibleRect.width : WIDTH, ti.visibleRect ? ti.visibleRect.height : HEIGHT, ti.pixelFormat);
			} finally {
				tex.release();
			}
			if (r === 1) sentOk++; else if (r === 0) droppedBusy++; else failed++;
			return;
		}
		tex.release();
	});

	win.webContents.on('render-process-gone', (e, d) => {
		console.error(`[texprobe] RENDERER GONE: ${d.reason}`);
		app.exit(3);
	});

	if (MODE === 'send') {
		setInterval(() => {
			const now = Date.now();
			const paintFps = (paints - lastPaints) / ((now - lastTime) / 1000);
			lastPaints = paints; lastTime = now;
			const s = sender.stats();
			console.log(`[texprobe] paintFps=${paintFps.toFixed(1)} submitted=${sentOk} busyDrops=${droppedBusy} failed=${failed} noTexture=${noTexture} | native sent=${s.sent} dropped=${s.dropped} openFails=${s.openFails} map=${s.mapMs}ms send=${s.latencyMs}ms q=${s.inFlight}${s.lastError ? ' lastError=' + s.lastError : ''} conn=${sender.connections()}`);
		}, 5000);
	}

	if (DURATION_S > 0) {
		setTimeout(() => {
			console.log(`[texprobe] duration reached — exiting under watchdog`);
			const { spawn } = require('child_process');
			spawn('cmd.exe', ['/c', `ping -n 7 127.0.0.1 >nul & taskkill /F /PID ${process.pid}`],
				{ detached: true, stdio: 'ignore', windowsHide: true }).unref();
			if (sender) { sender.destroy().catch(() => {}); }
			app.exit(0);
		}, DURATION_S * 1000);
	}

	await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
	console.log('[texprobe] page loaded — painting');
}).catch(err => {
	console.error('[texprobe] FATAL:', err);
	app.exit(1);
});
