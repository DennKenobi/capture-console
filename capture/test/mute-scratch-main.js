// Session 8 Part B verify-early scratch — is Electron-level page mute safe on a live
// audio worker? (SESSION8-SPEC §2: gate for the mute/solo feature.)
// Clone of audio-main.js plus: a polled command file driving
// webContents.setAudioMuted(), and page-lifecycle instrumentation proving the
// stream never reconnects across mute/unmute cycles (loadCount must stay 1).
// The mechanism is sanctioned by §0: app-layer page mute only — no Web Audio touch,
// no vdo.ninja injection, no routing change.
//
//   electron ./capture/test/mute-scratch-main.js --url="…" --user-data-dir=…
//       [--cmd-file=<path>]   (default <user-data-dir>/audio.cmd; polled 500 ms)
//   cmd file lines: mute | unmute | status | quit
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

function arg(name, dflt) {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : dflt;
}
const URL = arg('url', '');
const USER_DATA_DIR = arg('user-data-dir', '');
if (!URL || !USER_DATA_DIR) { console.error('[scratch] --url and --user-data-dir are required'); app.exit(2); }
const CMD_FILE = arg('cmd-file', path.join(USER_DATA_DIR, 'audio.cmd'));

app.setPath('userData', USER_DATA_DIR);
app.setPath('sessionData', USER_DATA_DIR);

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function ts() { return new Date().toISOString().slice(11, 23); }
function log(line) { console.log(`${ts()} [scratch] ${line}`); }

// Reconnect instrumentation: if mute/unmute ever disturbs the page or the WebRTC
// connection enough to reload, these counters move. loadCount must end at 1.
let loadCount = 0, navCount = 0, startLoadCount = 0;

app.whenReady().then(async () => {
	log(`Electron ${process.versions.electron} | url=${URL}`);
	const allow = new Set(['media', 'audioCapture', 'speaker-selection']);
	session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(allow.has(permission)));
	session.defaultSession.setPermissionCheckHandler((wc, permission) => allow.has(permission));

	const win = new BrowserWindow({
		show: false,
		width: 640,
		height: 360,
		webPreferences: { backgroundThrottling: false },
	});

	win.webContents.on('render-process-gone', (e, details) => {
		log(`RENDERER GONE: ${details.reason} (exitCode ${details.exitCode})`);
		app.exit(3);
	});
	win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
		if (isMainFrame && code !== -3) { log(`LOAD FAILED: ${code} ${desc}`); app.exit(4); }
	});
	win.webContents.on('did-finish-load', () => { loadCount++; log(`page loaded (loadCount=${loadCount})`); });
	win.webContents.on('did-start-loading', () => { startLoadCount++; });
	win.webContents.on('did-navigate', (e, url) => { navCount++; log(`did-navigate #${navCount}: ${url}`); });
	win.webContents.on('audio-state-changed', (e) => { log(`audio-state-changed: audible=${e.audible}`); });

	// Polled command file (stdin is not readable on Windows Electron mains — Session 5).
	setInterval(() => {
		let text;
		try { text = fs.readFileSync(CMD_FILE, 'utf8'); } catch { return; }
		if (!text.trim()) return;
		try { fs.writeFileSync(CMD_FILE, ''); } catch {}
		for (const raw of text.split(/\r?\n/)) {
			const cmd = raw.trim();
			if (!cmd) continue;
			if (cmd === 'mute' || cmd === 'unmute') {
				const want = cmd === 'mute';
				win.webContents.setAudioMuted(want);
				log(`setAudioMuted(${want}) -> isAudioMuted=${win.webContents.isAudioMuted()} loads=${loadCount} navs=${navCount} startLoads=${startLoadCount}`);
			} else if (cmd === 'status') {
				log(`status: isAudioMuted=${win.webContents.isAudioMuted()} loads=${loadCount} navs=${navCount} startLoads=${startLoadCount} rssMB=${Math.round(process.memoryUsage().rss / 1048576)}`);
			} else if (cmd === 'quit') {
				log(`quit requested; final: loads=${loadCount} navs=${navCount} startLoads=${startLoadCount}`);
				app.exit(0);
			} else {
				log(`unknown cmd: ${cmd}`);
			}
		}
	}, 500);

	setInterval(() => {
		log(`alive rssMB=${Math.round(process.memoryUsage().rss / 1048576)} muted=${win.webContents.isAudioMuted()} loads=${loadCount}`);
	}, 10000);

	await win.loadURL(URL);
}).catch(err => {
	console.error('[scratch] FATAL:', err);
	app.exit(1);
});
