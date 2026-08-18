// Audio worker — Capture Console fork, Phase 1 (ARCHITECTURE.md §2 "Audio Surface").
// A hidden page whose entire job is letting vdo.ninja place one player's mono audio on
// one channel of the configured output device. No NDI, no OSR, no audio processing here —
// everything is baked into the URL (&novideo&audiooutput=…&channeloffset=…), immutable.
// This module stays free of EC internals and NDI by design (ASS portability, §9).
//
//   electron ./capture/audio-main.js --url="…" [--user-data-dir=…] [--status-json] [--duration=s]
const { app, BrowserWindow, session } = require('electron');

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

	setInterval(() => {
		const rssMB = Math.round(process.memoryUsage().rss / 1048576);
		console.log(`[audio] rssMB=${rssMB}`);
		emit('stats', { rssMB });
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
