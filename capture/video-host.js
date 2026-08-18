// Consolidated video host — Capture Console fork, Session 5 (Tier B topology).
// ONE Electron process hosting N offscreen video surfaces (one hidden BrowserWindow +
// one NDI sender per source from sources.json). The OBS-rig shape: one Chromium
// infrastructure, per-player renderer processes, shared GPU process. Carries ZERO audio
// state (&noaudio views only) — consolidation cannot reintroduce the audio cross-talk
// class; the trade is GPU-process crash blast radius (all video blinks ~2 s, audio
// planes unaffected).
//
//   electron ./capture/video-host.js --config=path/to/sources.json
//     [--source=<name>] [--user-data-dir=<dir>] [--status-json] [--duration=s]
//
// stdin commands (supervisor integration, consolidated topology):
//   status | reload <player> | stop <player> | start <player> | quit
//
// Status protocol: same JSON lines as slice-main.js, tagged per player:
//   {"ev":"ready"|"loaded"|"stats"|"window-gone"|"window-failed"|"exiting",
//    "plane":"video","player":<name>,...}
// Window-level failures self-heal in-process (backoff ladder, per-player blast radius);
// whole-process death is the supervisor's to handle.
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const readline = require('readline');
const ndi = require('./ndi-sender');
const builder = require('./url-builder');

function arg(name, dflt) {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : dflt;
}
const CONFIG_PATH = arg('config', '');
const ONLY_SOURCE = arg('source', '');
const USER_DATA_DIR = arg('user-data-dir', '');
const DURATION_S = parseInt(arg('duration', '0'), 10);
const STATUS_JSON = process.argv.includes('--status-json');
// Consolidated processes need a deeper send pipeline than per-player ones: completion
// callbacks share one busy main loop (see ndi-sender.js).
const NDI_DEPTH = parseInt(arg('ndi-depth', '4'), 10);

if (!CONFIG_PATH) { console.error('[vhost] --config=<path> is required'); app.exit(2); }

if (USER_DATA_DIR) {
	app.setPath('userData', USER_DATA_DIR);
	app.setPath('sessionData', USER_DATA_DIR);
}

function emit(ev, player, extra) {
	if (!STATUS_JSON) return;
	console.log(JSON.stringify(Object.assign({ ev, plane: 'video', player }, extra || {})));
}

// Same never-throttle set as slice-main.js — every window is hidden for life.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const REBUILD_BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];
const MAX_REBUILDS = 5;
const HEALTHY_RESET_MS = 120000;

// state: starting | running | backoff | stopped | failed
const surfaces = new Map(); // player name -> surface record

function makeSurface(source, defaults) {
	return {
		name: source.name,
		url: builder.videoUrl(source, defaults),
		ndiName: builder.ndiName(source, defaults),
		video: builder.resolveVideo(source, defaults),
		win: null, sender: null,
		state: 'starting', rebuilds: 0, requestedStop: false,
		paints: 0, lastPaints: 0, lastTime: Date.now(),
		copyNs: 0n, copies: 0,
		backoffTimer: null, healthyTimer: null,
	};
}

function buildWindow(s) {
	const win = new BrowserWindow({
		show: false,
		width: s.video.width,
		height: s.video.height,
		webPreferences: { offscreen: true, backgroundThrottling: false },
	});
	win.webContents.setFrameRate(s.video.fps);

	win.webContents.on('paint', (event, dirty, image) => {
		s.paints++;
		const size = image.getSize();
		// toBitmap() copies — paint-owned buffer must not reach NDI's async thread.
		const t0 = process.hrtime.bigint();
		const bitmap = image.toBitmap();
		s.copyNs += process.hrtime.bigint() - t0;
		s.copies++;
		s.sender.sendFrame(bitmap, size.width, size.height, size.width * 4);
	});

	win.webContents.on('render-process-gone', (e, details) => {
		console.error(`[vhost] ${s.name} RENDERER GONE: ${details.reason} (exitCode ${details.exitCode})`);
		emit('window-gone', s.name, { reason: `renderer-gone:${details.reason}` });
		scheduleRebuild(s);
	});
	win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
		if (!isMainFrame || code === -3) return;
		console.error(`[vhost] ${s.name} LOAD FAILED: ${code} ${desc}`);
		emit('window-gone', s.name, { reason: `load-failed:${code}` });
		scheduleRebuild(s);
	});
	win.webContents.on('did-finish-load', () => {
		s.state = 'running';
		console.log(`[vhost] ${s.name} page loaded`);
		emit('loaded', s.name, {});
		clearTimeout(s.healthyTimer);
		s.healthyTimer = setTimeout(() => { s.rebuilds = 0; }, HEALTHY_RESET_MS);
	});
	return win;
}

function destroyWindow(s) {
	clearTimeout(s.backoffTimer);
	clearTimeout(s.healthyTimer);
	if (s.win && !s.win.isDestroyed()) s.win.destroy();
	s.win = null;
}

// Window-level self-heal: per-player blast radius stays per-player in the
// consolidated shape. The NDI sender survives rebuilds (name never re-created,
// so the lingering-name gotcha never triggers here).
function scheduleRebuild(s) {
	destroyWindow(s);
	if (s.requestedStop || shuttingDown) { s.state = 'stopped'; return; }
	if (s.rebuilds >= MAX_REBUILDS) {
		s.state = 'failed';
		console.error(`[vhost] ${s.name} FAILED after ${MAX_REBUILDS} rebuilds — window down, siblings unaffected`);
		emit('window-failed', s.name, {});
		return;
	}
	const delay = REBUILD_BACKOFF_MS[Math.min(s.rebuilds, REBUILD_BACKOFF_MS.length - 1)];
	s.rebuilds++;
	s.state = 'backoff';
	console.log(`[vhost] ${s.name} rebuild ${s.rebuilds}/${MAX_REBUILDS} in ${delay / 1000}s`);
	s.backoffTimer = setTimeout(() => startSurface(s), delay);
}

async function startSurface(s) {
	s.requestedStop = false;
	s.state = 'starting';
	if (!s.sender) {
		s.sender = await ndi.create(s.ndiName, { fps: s.video.fps, depth: NDI_DEPTH });
		emit('ready', s.name, { ndiName: s.ndiName });
	}
	s.win = buildWindow(s);
	try {
		await s.win.loadURL(s.url);
	} catch (err) {
		// did-fail-load fires for main-frame failures and schedules the rebuild;
		// loadURL's rejection is the same event surfacing as a promise.
		console.error(`[vhost] ${s.name} loadURL rejected: ${err.message}`);
	}
}

function stopSurface(s) {
	s.requestedStop = true;
	destroyWindow(s);
	s.state = 'stopped';
	console.log(`[vhost] ${s.name} stopped`);
}

let shuttingDown = false;
async function shutdown(reason) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[vhost] shutting down (${reason})`);
	for (const [, s] of surfaces) {
		emit('exiting', s.name, { reason });
		destroyWindow(s);
	}
	// Sender destroys can hang (native lib, live receiver connections) — never let
	// them block process exit. 3 s grace, then exit regardless; OS reclaims the rest.
	const destroys = [...surfaces.values()].map(async s => {
		if (s.sender) { try { await s.sender.destroy(); } catch {} s.sender = null; }
	});
	await Promise.race([Promise.all(destroys), new Promise(r => setTimeout(r, 3000))]);
	app.exit(0);
}

app.whenReady().then(async () => {
	console.log(`[vhost] Electron ${process.versions.electron} | Chromium ${process.versions.chrome} | Node ${process.versions.node}`);

	const fs = require('fs');
	const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
	const errors = builder.validateConfig(config);
	if (errors.length) {
		console.error('[vhost] sources.json invalid:');
		for (const e of errors) console.error('  - ' + e);
		app.exit(2);
		return;
	}

	const sources = config.sources.filter(src => !ONLY_SOURCE || src.name === ONLY_SOURCE);
	console.log(`[vhost] hosting ${sources.length} video surface(s) from ${CONFIG_PATH}`);
	for (const source of sources) surfaces.set(source.name, makeSurface(source, config.defaults));

	// Sequenced bring-up: one surface at a time, wait for loaded (KICKOFF §5 rule).
	for (const [, s] of surfaces) {
		await startSurface(s);
		await new Promise(resolve => {
			if (s.state === 'running') return resolve();
			const iv = setInterval(() => {
				if (s.state === 'running' || s.state === 'backoff' || s.state === 'failed') { clearInterval(iv); resolve(); }
			}, 250);
			setTimeout(() => { clearInterval(iv); resolve(); }, 30000);
		});
	}
	console.log('[vhost] bring-up complete');

	setInterval(() => {
		const now = Date.now();
		const rssMB = Math.round(process.memoryUsage().rss / 1048576);
		for (const [, s] of surfaces) {
			const paintFps = (s.paints - s.lastPaints) / ((now - s.lastTime) / 1000);
			s.lastPaints = s.paints; s.lastTime = now;
			if (s.state !== 'running' && s.state !== 'starting') continue;
			const st = s.sender ? s.sender.stats() : { sent: 0, dropped: 0, latencyMs: 0 };
			const copyMs = s.copies ? Number(s.copyNs / BigInt(s.copies)) / 1e6 : 0;
			s.copyNs = 0n; s.copies = 0;
			console.log(`[vhost] ${s.name} paintFps=${paintFps.toFixed(1)} sent=${st.sent} dropped=${st.dropped} lat=${st.latencyMs}ms copy=${copyMs.toFixed(1)}ms rssMB=${rssMB}`);
			emit('stats', s.name, { paintFps: +paintFps.toFixed(1), sent: st.sent, dropped: st.dropped, latencyMs: st.latencyMs, copyMs: +copyMs.toFixed(1), rssMB });
		}
	}, 10000);

	readline.createInterface({ input: process.stdin }).on('line', line => {
		const [cmd, player] = line.trim().split(/\s+/);
		if (!cmd) return;
		if (cmd === 'quit') return void shutdown('quit');
		if (cmd === 'status') {
			for (const [, s] of surfaces) console.log(`  ${s.name.padEnd(16)} ${s.state.padEnd(9)} rebuilds=${s.rebuilds}`);
			return;
		}
		const s = surfaces.get(player);
		if (!s) return console.log(`[vhost] unknown player: ${player}`);
		if (cmd === 'stop') return stopSurface(s);
		if (cmd === 'start') { s.rebuilds = 0; return void startSurface(s); }
		if (cmd === 'reload') {
			console.log(`[vhost] RELOAD ${s.name}`);
			destroyWindow(s);
			s.rebuilds = 0;
			return void startSurface(s);
		}
		console.log('[vhost] commands: status | reload <player> | stop <player> | start <player> | quit');
	});

	if (DURATION_S > 0) setTimeout(() => shutdown('duration'), DURATION_S * 1000);
}).catch(err => {
	console.error('[vhost] FATAL:', err);
	app.exit(1);
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
