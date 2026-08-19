// Audio worker — Capture Console fork, Phase 1 (ARCHITECTURE.md §2 "Audio Surface").
// A hidden page whose entire job is letting vdo.ninja place one player's mono audio on
// one channel of the configured output device. No NDI, no OSR, no audio processing here —
// everything is baked into the URL (&novideo&audiooutput=…&channeloffset=…), immutable.
// This module stays free of EC internals and NDI by design (ASS portability, §9).
//
// Session 8 adds the ONE sanctioned app-layer surface (KICKOFF Phase 4 "page volume,
// not routing"): Electron-level page mute via a polled <user-data-dir>/audio.cmd file
// (stdin is not readable on Windows — Session 5). setAudioMuted touches nothing but
// the page's audio output — never the Web Audio graph, never the page, never routing.
//
//   electron ./capture/audio-main.js --url="…" [--user-data-dir=…] [--status-json] [--duration=s]
//   audio.cmd lines: mute | unmute
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

function arg(name, dflt) {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : dflt;
}
const URL = arg('url', '');
const DURATION_S = parseInt(arg('duration', '0'), 10);
const USER_DATA_DIR = arg('user-data-dir', '');
const STATUS_JSON = process.argv.includes('--status-json');

if (!URL) { console.error('[audio] --url is required'); app.exit(2); }

if (USER_DATA_DIR) {
	app.setPath('userData', USER_DATA_DIR);
	app.setPath('sessionData', USER_DATA_DIR);
}

function emit(ev, extra) {
	if (!STATUS_JSON) return;
	console.log(JSON.stringify(Object.assign({ ev, plane: 'audio' }, extra || {})));
}

// The window is hidden for its entire life; audio must keep flowing regardless.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
	console.log(`[audio] Electron ${process.versions.electron} | url=${URL}`);

	// &audiooutput matches by device LABEL — labels only enumerate when media permission
	// is granted, so grant it (and nothing else) for this session.
	const allow = new Set(['media', 'audioCapture', 'speaker-selection']);
	session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(allow.has(permission)));
	session.defaultSession.setPermissionCheckHandler((wc, permission) => allow.has(permission));

	const win = new BrowserWindow({
		show: false,
		width: 640,
		height: 360,
		webPreferences: { backgroundThrottling: false },
	});
	emit('ready', {});

	win.webContents.on('render-process-gone', (e, details) => {
		console.error(`[audio] RENDERER GONE: ${details.reason} (exitCode ${details.exitCode})`);
		emit('exiting', { reason: `renderer-gone:${details.reason}` });
		app.exit(3);
	});
	win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
		console.error(`[audio] LOAD FAILED: ${code} ${desc}`);
		if (isMainFrame && code !== -3) { emit('exiting', { reason: `load-failed:${code}` }); app.exit(4); }
	});
	win.webContents.on('did-finish-load', () => { console.log('[audio] page loaded'); emit('loaded', {}); });

	// Mute surface: poll the per-worker command file at 500 ms (mute is a live operator
	// action — the 2 s supervisor cadence already dominates latency). Only mute/unmute
	// travel here, both idempotent, so a line left stale across a worker restart is
	// harmless (the console reconciles intent vs reported state anyway).
	if (USER_DATA_DIR) {
		const cmdFile = path.join(USER_DATA_DIR, 'audio.cmd');
		setInterval(() => {
			let text;
			try { text = fs.readFileSync(cmdFile, 'utf8'); } catch { return; }
			if (!text.trim()) return;
			try { fs.writeFileSync(cmdFile, ''); } catch {}
			for (const raw of text.split(/\r?\n/)) {
				const cmd = raw.trim();
				if (cmd !== 'mute' && cmd !== 'unmute') {
					if (cmd) console.log(`[audio] unknown cmd: ${cmd}`);
					continue;
				}
				const want = cmd === 'mute';
				win.webContents.setAudioMuted(want);
				console.log(`[audio] page mute -> ${want}`);
				emit('muted', { muted: want });
			}
		}, 500);
	}

	setInterval(() => {
		const rssMB = Math.round(process.memoryUsage().rss / 1048576);
		console.log(`[audio] rssMB=${rssMB}`);
		emit('stats', { rssMB, muted: win.webContents.isAudioMuted() });
	}, 10000);

	if (DURATION_S > 0) {
		setTimeout(() => {
			console.log(`[audio] duration ${DURATION_S}s reached; exiting`);
			emit('exiting', { reason: 'duration' });
			app.exit(0);
		}, DURATION_S * 1000);
	}

	await win.loadURL(URL);
}).catch(err => {
	console.error('[audio] FATAL:', err);
	app.exit(1);
});
