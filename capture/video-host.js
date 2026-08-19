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

const { app, BrowserWindow, utilityProcess } = require('electron');
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
// callbacks share one busy main loop and return 50-200 ms late in bursts; depth 8
// absorbs them fully at 6×30fps (depth 2 → ~10 fps sent, depth 4 → ~19, depth 8 →
// paint rate with ~zero drops; measured 2026-08-18).
const NDI_DEPTH = parseInt(arg('ndi-depth', '8'), 10);
// Sender placement: 'inline' = sends from this main process; 'proc' = sends from a
// utilityProcess with its own event loop, shedding all N-API submit + completion
// work from the main loop at the price of one extra frame copy (postMessage
// serialize, ~3 ms/1080p). SharedArrayBuffer/transfer are NOT supported across
// utilityProcess postMessage (probed 2026-08-18), so copy semantics it is.
const SENDER_MODE = arg('sender', 'inline');

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

// ---- utility-process sender (SENDER_MODE === 'proc') ----------------------
let uProc = null;
const procReadyWaiters = new Map(); // player -> {resolve, reject}

function spawnSenderProc() {
	uProc = utilityProcess.fork(path.join(__dirname, 'ndi-sender-proc.js'), [], {
		stdio: 'inherit', serviceName: 'cc-ndi-sender',
	});
	uProc.on('message', m => {
		if (m.type === 'log') { console.log(m.line); return; }
		if (m.type === 'stats') {
			for (const [player, st] of Object.entries(m.players)) {
				const s = surfaces.get(player);
				if (s) s.procStats = st;
			}
			return;
		}
		if (m.type === 'ready' || m.type === 'create-failed') {
			const w = procReadyWaiters.get(m.player);
			procReadyWaiters.delete(m.player);
			if (!w) return;
			if (m.type === 'ready') w.resolve();
			else w.reject(new Error(m.error));
		}
	});
	uProc.on('exit', code => {
		if (shuttingDown) return;
		console.error(`[vhost] sender proc died (code ${code}) — respawning and re-creating senders`);
		emit('sender-proc-died', 'videohost', { code });
		for (const [, s] of surfaces) s.senderReady = false;
		spawnSenderProc();
		for (const [, s] of surfaces) {
			if (s.state === 'running' || s.state === 'starting') {
				procCreateSender(s).catch(err => console.error(`[vhost] ${s.name} sender re-create failed: ${err.message}`));
			}
		}
	});
}

function procCreateSender(s) {
	return new Promise((resolve, reject) => {
		procReadyWaiters.set(s.name, { resolve, reject });
		uProc.postMessage({ type: 'create', player: s.name, name: s.ndiName, fps: s.video.fps, depth: NDI_DEPTH });
	}).then(() => { s.senderReady = true; });
}

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
		if (s.retired) return; // parked window may still paint about:blank
		if (SENDER_MODE !== 'proc' && !s.sender) return;
		s.paints++;
		const size = image.getSize();
		// toBitmap() copies — paint-owned buffer must not reach NDI's async thread.
		const t0 = process.hrtime.bigint();
		const bitmap = image.toBitmap();
		s.copyNs += process.hrtime.bigint() - t0;
		s.copies++;
		if (SENDER_MODE === 'proc') {
			if (s.senderReady && uProc) {
				uProc.postMessage({ type: 'frame', player: s.name, w: size.width, h: size.height, stride: size.width * 4, data: bitmap });
			}
		} else {
			s.sender.sendFrame(bitmap, size.width, size.height, size.width * 4);
		}
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

// BrowserWindow.destroy() on a LIVE offscreen window wedges this build's main
// loop (observed twice, 2026-08-18: the removal path's last log line prints,
// then no timer/poller ever runs again — with and without a sender destroy).
// Windows are therefore NEVER destroyed while the host lives: removals park
// them on about:blank, reloads and self-heals REUSE the window via loadURL
// (which spawns a fresh renderer after a crash). destroy happens only in
// shutdown, where the external watchdog bounds any hang.
function parkWindow(s) {
	clearTimeout(s.backoffTimer);
	clearTimeout(s.healthyTimer);
	if (s.win && !s.win.isDestroyed()) {
		try { s.win.loadURL('about:blank'); } catch {}
	}
}

// Window-level self-heal: per-player blast radius stays per-player in the
// consolidated shape. The NDI sender survives rebuilds (name never re-created,
// so the lingering-name gotcha never triggers here).
function scheduleRebuild(s) {
	clearTimeout(s.backoffTimer);
	clearTimeout(s.healthyTimer);
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
	s.retired = false;
	s.state = 'starting';
	if (SENDER_MODE === 'proc') {
		if (!s.senderReady) {
			await procCreateSender(s);
			emit('ready', s.name, { ndiName: s.ndiName });
		}
	} else if (!s.sender) {
		s.sender = await ndi.create(s.ndiName, { fps: s.video.fps, depth: NDI_DEPTH });
		emit('ready', s.name, { ndiName: s.ndiName });
	}
	// Reuse an existing window whenever possible — see the parkWindow note.
	if (!s.win || s.win.isDestroyed()) s.win = buildWindow(s);
	else s.win.webContents.setFrameRate(s.video.fps);
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
	parkWindow(s);
	s.state = 'stopped';
	console.log(`[vhost] ${s.name} stopped`);
}

function readConfigFile() {
	const fs = require('fs');
	try {
		const fresh = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
		const errors = builder.validateConfig(fresh);
		if (errors.length) { console.error(`[vhost] config invalid: ${errors.join('; ')}`); return null; }
		return fresh;
	} catch (err) {
		console.error(`[vhost] config unreadable: ${err.message}`);
		return null;
	}
}

// Parked senders from removed/renamed surfaces: destroying a sender in a LIVE
// multi-sender host wedges the main loop even after a drain (observed 2026-08-18:
// last log line printed, then no tick ever ran again). Senders are therefore only
// ever destroyed at process shutdown (external watchdog covers a hang there);
// until then a removed player's name stays advertised with its last frame.
const parkedSenders = [];

async function retireSurface(s) {
	s.retired = true;
	stopSurface(s);
	if (SENDER_MODE === 'proc') {
		if (uProc && s.senderReady) uProc.postMessage({ type: 'destroy', player: s.name });
		s.senderReady = false;
	} else if (s.sender) {
		parkedSenders.push(s.sender);
		console.log(`[vhost] ${s.name} sender parked (name frees on host restart)`);
		s.sender = null;
	}
	surfaces.delete(s.name);
	emit('exiting', s.name, { reason: 'removed' });
}

// Reconcile surfaces to the config file on disk: add new, retire removed.
// Existing surfaces are untouched (their reload re-derives from fresh config).
async function rescanSurfaces() {
	const fresh = readConfigFile();
	if (!fresh) return;
	const sources = fresh.sources.filter(src => !ONLY_SOURCE || src.name === ONLY_SOURCE);
	const wanted = new Set(sources.map(src => src.name));
	for (const [name, s] of [...surfaces]) {
		if (!wanted.has(name)) {
			console.log(`[vhost] rescan: removing ${name}`);
			await retireSurface(s);
		}
	}
	for (const source of sources) {
		if (!surfaces.has(source.name)) {
			console.log(`[vhost] rescan: adding ${source.name}`);
			const s = makeSurface(source, fresh.defaults);
			surfaces.set(source.name, s);
			await startSurface(s);
		}
	}
	console.log('[vhost] rescan complete');
}

// Reload one surface from the config file on disk (URL/geometry/NDI-name edits
// apply). The sender is kept unless the NDI name changed.
async function reloadSurface(s) {
	const fresh = readConfigFile();
	if (fresh) {
		const source = fresh.sources.find(src => src.name === s.name);
		if (source) {
			const next = makeSurface(source, fresh.defaults);
			if (next.ndiName !== s.ndiName) {
				console.log(`[vhost] ${s.name} NDI name change ${s.ndiName} -> ${next.ndiName}`);
				if (SENDER_MODE === 'proc') {
					if (uProc && s.senderReady) uProc.postMessage({ type: 'destroy', player: s.name });
					s.senderReady = false;
				} else if (s.sender) {
					// never destroy in a live host — see parkedSenders note
					parkedSenders.push(s.sender);
					console.log(`[vhost] ${s.name} old sender parked (name frees on host restart)`);
					s.sender = null;
				}
			}
			s.url = next.url; s.ndiName = next.ndiName; s.video = next.video;
		}
	}
	s.rebuilds = 0;
	return startSurface(s); // reuses the window; loadURL replaces the page
}

let shuttingDown = false;
async function shutdown(reason) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[vhost] shutting down (${reason})`);
	// External watchdog: a native destroy() that blocks the main loop cannot be
	// escaped by any JS timer — only another process can kill us. Normal exit wins.
	const { spawn } = require('child_process');
	spawn('cmd.exe', ['/c', `ping -n 9 127.0.0.1 >nul & taskkill /F /PID ${process.pid}`],
		{ detached: true, stdio: 'ignore', windowsHide: true }).unref();
	for (const [, s] of surfaces) {
		emit('exiting', s.name, { reason });
		clearTimeout(s.backoffTimer);
		clearTimeout(s.healthyTimer);
		// windows die with the process — destroy() wedges a live host
	}
	if (SENDER_MODE === 'proc' && uProc) {
		// The utility process owns the senders: ask it to drain+destroy and exit.
		const exited = new Promise(r => uProc.once('exit', r));
		uProc.postMessage({ type: 'shutdown' });
		await Promise.race([exited, new Promise(r => setTimeout(r, 3000))]);
	} else {
		// Destroying a sender with a send in flight deadlocks the main thread (the
		// completion callback needs the thread destroy blocks). Drain first; if a sender
		// won't drain, skip its destroy — process exit reclaims it, the name lingers
		// either way, and the create-retry ladder covers the respawn.
		for (const [, s] of surfaces) {
			if (!s.sender) continue;
			const drained = await s.sender.drain(500);
			if (drained) { try { await s.sender.destroy(); } catch {} }
			else console.log(`[vhost] ${s.name} sender not drained — skipping destroy`);
			s.sender = null;
		}
	}
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
	console.log(`[vhost] hosting ${sources.length} video surface(s) from ${CONFIG_PATH} (sender=${SENDER_MODE}, depth=${NDI_DEPTH})`);
	if (SENDER_MODE === 'proc') spawnSenderProc();
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
	// Host-level loaded signal: drives the supervisor's sequenced-bring-up gate for
	// the consolidated worker (per-player 'loaded' lines are informational there).
	emit('host-loaded', 'videohost', { players: surfaces.size });

	setInterval(() => {
		const now = Date.now();
		const rssMB = Math.round(process.memoryUsage().rss / 1048576);
		for (const [, s] of surfaces) {
			const paintFps = (s.paints - s.lastPaints) / ((now - s.lastTime) / 1000);
			s.lastPaints = s.paints; s.lastTime = now;
			if (s.state !== 'running' && s.state !== 'starting') continue;
			const st = SENDER_MODE === 'proc'
				? (s.procStats || { sent: 0, dropped: 0, latencyMs: 0 })
				: (s.sender ? s.sender.stats() : { sent: 0, dropped: 0, latencyMs: 0 });
			const copyMs = s.copies ? Number(s.copyNs / BigInt(s.copies)) / 1e6 : 0;
			s.copyNs = 0n; s.copies = 0;
			const conn = SENDER_MODE === 'proc' ? 'proc' : (s.sender ? s.sender.connections() : '-');
			console.log(`[vhost] ${s.name} paintFps=${paintFps.toFixed(1)} sent=${st.sent} dropped=${st.dropped} lat=${st.latencyMs}ms copy=${copyMs.toFixed(1)}ms conn=${conn} rssMB=${rssMB}`);
			emit('stats', s.name, { paintFps: +paintFps.toFixed(1), sent: st.sent, dropped: st.dropped, latencyMs: st.latencyMs, copyMs: +copyMs.toFixed(1), rssMB });
		}
	}, 10000);

	function handleCommand(line) {
		const [cmd, player] = line.trim().split(/\s+/);
		if (!cmd) return;
		if (cmd === 'quit') return void shutdown('quit');
		if (cmd === 'rescan') return void rescanSurfaces();
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
			return void reloadSurface(s);
		}
		console.log('[vhost] commands: status | reload <player> | stop <player> | start <player> | rescan | quit');
	}
	// stdin works in dev on POSIX, but a piped stdin into an Electron main process
	// is NOT reliably readable on Windows (verified 2026-08-18: readline never fired
	// for supervisor-forwarded lines). The command channel that actually carries
	// supervisor traffic is a polled file, same pattern as supervisor.cmd.
	readline.createInterface({ input: process.stdin }).on('line', handleCommand);
	const cmdFile = path.join(path.dirname(path.resolve(CONFIG_PATH)), 'vhost.cmd');
	setInterval(() => {
		const fs2 = require('fs');
		let text;
		try { text = fs2.readFileSync(cmdFile, 'utf8'); } catch { return; }
		if (!text.trim()) return;
		try { fs2.writeFileSync(cmdFile, ''); } catch {}
		for (const line of text.split(/\r?\n/)) {
			if (line.trim()) { console.log(`[vhost] cmd-file: ${line.trim()}`); handleCommand(line); }
		}
	}, 2000);

	if (DURATION_S > 0) setTimeout(() => shutdown('duration'), DURATION_S * 1000);
}).catch(err => {
	console.error('[vhost] FATAL:', err);
	app.exit(1);
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
