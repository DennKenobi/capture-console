// Management console — Capture Console fork, Session 5 Part C (KICKOFF §5 Phase 2).
// The supervisor's UI face: source CRUD on sources.json, per-plane start/stop/reload,
// live status. The operator never touches OBS or raw config mid-session.
//
//   electron ./capture/console-main.js [--config=path/to/sources.json]
//
// Process model (ARCHITECTURE §2 "console death leaves workers streaming"):
// the console spawns supervisor.js FULLY DETACHED (no pipes, own process group) and
// couples to it only through files in the config directory:
//   supervisor.pid          — liveness + adoption of a pre-existing supervisor
//   supervisor.cmd          — command channel (append lines; supervisor polls)
//   supervisor-status.json  — 2 s status snapshots (atomic tmp+rename)
// Killing the console therefore cannot disturb a single worker, and a fresh console
// re-adopts a running supervisor by reading the same files.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const builder = require('./url-builder');
const { PreviewManager } = require('./console-previews');

function argOf(name, dflt) {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : dflt;
}

// Own data dir (optional): isolates the console profile and makes the whole
// console process tree markable for bench sampling (tree-cpu.ps1 -Marker <dir>).
const USER_DATA_DIR = argOf('user-data-dir', '');
if (USER_DATA_DIR) app.setPath('userData', path.resolve(USER_DATA_DIR));

const CONFIG_PATH = path.resolve(argOf('config', path.join(__dirname, 'sources.json')));
const configDir = path.dirname(CONFIG_PATH);
const pidPath = path.join(configDir, 'supervisor.pid');
const cmdPath = path.join(configDir, 'supervisor.cmd');
const statusPath = path.join(configDir, 'supervisor-status.json');

function supervisorPid() {
	try {
		const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
		if (pid) { process.kill(pid, 0); return pid; }
	} catch {}
	return 0;
}

function readJson(p) {
	try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ---- previews (Session 7 Part A) -------------------------------------------
// Receivers live here in console main; toggle state is console-session-local
// (default ON — budget-gated, see fork CLAUDE.md Session 7). OFF really tears
// the receiver down: a connected receiver makes the sender encode.

let mainWin = null;
const previews = new PreviewManager(
	(channel, payload) => {
		if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
		// Session 8 Part D: fan the SAME frames out to that player's pop-out (if any) —
		// no extra receiver, no extra bandwidth, the pop-out is just a second canvas.
		if (channel === 'preview-frame' && payload && payload.player) {
			const pop = popouts.get(payload.player);
			if (pop && !pop.isDestroyed()) pop.webContents.send(channel, payload);
		}
	},
	msg => console.log(msg),
);

// ---- preview pop-outs (Session 8 Part D) ------------------------------------
// Plain visible frameless BrowserWindows in the CONSOLE process painting the same
// proxy frames as the row canvases. Not offscreen, not the custom-OSR path, so
// close/destroy is normal Electron behavior — if any wedge symptom appears, switch
// to park-don't-destroy and ledger it (SESSION8-SPEC §4).
const popouts = new Map(); // player -> BrowserWindow

function popoutToggle(player) {
	const existing = popouts.get(player);
	if (existing) {
		if (!existing.isDestroyed()) existing.close();
		popouts.delete(player);
		return false;
	}
	const win = new BrowserWindow({
		width: 640,
		height: 360,
		useContentSize: true,
		frame: false,
		title: `${player} — preview`,
		backgroundColor: '#10161a',
		webPreferences: {
			preload: path.join(__dirname, 'console-preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	win.removeMenu();
	win.loadFile(path.join(__dirname, 'console-popout.html'), { query: { player } });
	win.on('closed', () => { if (popouts.get(player) === win) popouts.delete(player); });
	popouts.set(player, win);
	return true;
}

function popoutSync() {
	// close pop-outs whose player left the config (rescan-removed)
	const config = readJson(CONFIG_PATH);
	const names = new Set(config && config.sources ? config.sources.map(s => s.name) : []);
	for (const [player, win] of [...popouts]) {
		if (names.has(player)) continue;
		popouts.delete(player);
		if (!win.isDestroyed()) win.close();
	}
}

function popoutsShutdown() {
	for (const [, win] of popouts) { if (!win.isDestroyed()) win.close(); }
	popouts.clear();
}
let previewGlobal = true;
const previewRowOff = new Set(); // per-row opt-outs (default on)

function previewSync() {
	const config = readJson(CONFIG_PATH);
	const entries = [];
	if (previewGlobal && config && config.sources && !builder.validateConfig(config).length) {
		for (const s of config.sources) {
			if (previewRowOff.has(s.name)) continue;
			try { entries.push({ player: s.name, ndiName: builder.ndiName(s, config.defaults) }); } catch {}
		}
	}
	previews.sync(entries);
}

// ---- audio meters (Session 7 Part B) ---------------------------------------
// One meter-stream.ps1 helper per DISTINCT endpoint referenced in sources.json
// (v1 reality: just the one 8-ch VAIO). It reads IAudioMeterInformation on the
// render endpoint — the exact plane the workers write to; the workers themselves
// are untouched by design. Helper death is non-fatal: meters grey out in the
// renderer (staleness), rows keep working; respawn ladder below.

const meters = new Map(); // device fragment -> {child, backoffIdx, timer, retired}
const METER_BACKOFF_MS = [2000, 5000, 15000, 60000];

function meterEndpoints() {
	const config = readJson(CONFIG_PATH);
	const out = new Set();
	if (config && config.sources && !builder.validateConfig(config).length) {
		const defDev = (config.defaults && config.defaults.audio && config.defaults.audio.audioOutputDevice) || '';
		for (const s of config.sources) {
			const dev = (s.audio && s.audio.audioOutputDevice) || defDev;
			if (dev) out.add(dev);
		}
	}
	return out;
}

function spawnMeter(dev, entry) {
	entry.child = spawn('powershell.exe', [
		'-NoProfile', '-ExecutionPolicy', 'Bypass',
		'-File', path.join(__dirname, 'meter-stream.ps1'),
		'-DeviceMatch', dev, '-IntervalMs', '300',
	], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
	require('readline').createInterface({ input: entry.child.stdout }).on('line', line => {
		let parsed;
		try { parsed = JSON.parse(line); } catch { return; }
		if (parsed.error) { console.log(`[meter] ${dev}: ${parsed.error}`); return; }
		entry.backoffIdx = 0; // healthy stream resets the ladder
		if (mainWin && !mainWin.isDestroyed()) {
			// key by the config's device FRAGMENT (what rows map against), keep the
			// resolved endpoint label separately — parsed.device is the full label
			// and must not overwrite the lookup key
			mainWin.webContents.send('meter-update',
				Object.assign({}, parsed, { device: dev, deviceLabel: parsed.device }));
		}
	});
	entry.child.on('exit', code => {
		entry.child = null;
		if (entry.retired) return;
		const delay = METER_BACKOFF_MS[Math.min(entry.backoffIdx, METER_BACKOFF_MS.length - 1)];
		entry.backoffIdx++;
		console.log(`[meter] ${dev}: helper exited code=${code}; respawn in ${delay / 1000}s`);
		entry.timer = setTimeout(() => { if (!entry.retired) spawnMeter(dev, entry); }, delay);
	});
}

function meterSync() {
	const wanted = meterEndpoints();
	for (const [dev, entry] of [...meters]) {
		if (wanted.has(dev)) continue;
		entry.retired = true;
		clearTimeout(entry.timer);
		if (entry.child) { try { entry.child.kill(); } catch {} }
		meters.delete(dev);
		console.log(`[meter] ${dev}: retired`);
	}
	for (const dev of wanted) {
		if (meters.has(dev)) continue;
		const entry = { child: null, backoffIdx: 0, timer: null, retired: false };
		meters.set(dev, entry);
		console.log(`[meter] ${dev}: spawning helper`);
		spawnMeter(dev, entry);
	}
}

function metersShutdown() {
	for (const [, entry] of meters) {
		entry.retired = true;
		clearTimeout(entry.timer);
		if (entry.child) { try { entry.child.kill(); } catch {} }
	}
	meters.clear();
}

// ---- audio mute/solo (Session 8 Part B) ------------------------------------
// Live operator actions, NOT desired state (SESSION8-SPEC §2): intent lives here
// in console memory (like the preview toggles), truth lives in the worker and is
// read back from supervisor-status.json. Solo = mute all others. A worker that
// restarts comes back unmuted, so a rate-limited reconcile loop re-asserts intent
// against reported state through the sanctioned path (supervisor.cmd → audio.cmd).

const muteIntent = new Set(); // players individually muted by the operator
let soloPlayer = null;
const muteCmdAt = new Map(); // player -> ms of last issued command (re-send guard)
// Command → worker apply ≤2.5 s → status file ≤2 s: don't re-send inside that
// propagation window or every toggle double-fires.
const MUTE_RESEND_MS = 8000;

function desiredMute(player) {
	return muteIntent.has(player) || (soloPlayer !== null && player !== soloPlayer);
}

function muteSync(force) {
	if (!supervisorPid()) return;
	const status = readJson(statusPath);
	if (!status || Date.now() - status.at > 8000) return;
	const audioWorkers = status.workers.filter(w => w.plane === 'audio' && !w.consolidated);
	// drop intent for players that left the worker table (rescan-removed): a
	// re-added player starting silently muted would be an operator surprise
	const present = new Set(audioWorkers.map(w => w.player));
	for (const p of [...muteIntent]) if (!present.has(p)) muteIntent.delete(p);
	if (soloPlayer && !present.has(soloPlayer)) soloPlayer = null;
	for (const w of audioWorkers) {
		if (w.state !== 'running') continue;
		const want = desiredMute(w.player);
		if (want === !!w.muted) continue;
		const last = muteCmdAt.get(w.player) || 0;
		if (!force && Date.now() - last < MUTE_RESEND_MS) continue;
		muteCmdAt.set(w.player, Date.now());
		try { fs.appendFileSync(cmdPath, `${want ? 'mute' : 'unmute'} ${w.player} audio\n`); } catch {}
	}
}

// ---- IPC surface ----------------------------------------------------------

ipcMain.handle('state', () => {
	const config = readJson(CONFIG_PATH);
	const pid = supervisorPid();
	const status = pid ? readJson(statusPath) : null;
	return {
		configPath: CONFIG_PATH,
		config,
		configErrors: config ? builder.validateConfig(config) : ['sources.json missing or unparsable'],
		supervisorPid: pid,
		// a status snapshot older than 8 s means the supervisor is wedged or gone
		status: status && Date.now() - status.at < 8000 ? status : null,
		previews: {
			available: !previews.unavailable,
			reason: previews.unavailable || '',
			global: previewGlobal,
			rowOff: [...previewRowOff],
			states: previews.states(),
		},
		audioMix: { solo: soloPlayer, muted: [...muteIntent] },
		popouts: [...popouts.keys()],
	};
});

ipcMain.handle('popout-toggle', (e, player) => ({ ok: true, open: popoutToggle(player) }));

ipcMain.handle('audio-mute', (e, player, on) => {
	if (on) muteIntent.add(player); else muteIntent.delete(player);
	muteSync(true);
	return { ok: true };
});

ipcMain.handle('audio-solo', (e, player) => {
	soloPlayer = player || null;
	muteSync(true);
	return { ok: true };
});

ipcMain.handle('preview-toggle', (e, scope, on) => {
	if (scope === 'global') previewGlobal = !!on;
	else if (on) previewRowOff.delete(scope);
	else previewRowOff.add(scope);
	previewSync();
	return { ok: true };
});

ipcMain.handle('urls', (e, source, defaults) => {
	try {
		return {
			video: builder.videoUrl(source, defaults),
			audio: builder.audioUrl(source, defaults),
			ndiName: builder.ndiName(source, defaults),
		};
	} catch (err) {
		return { error: String(err && err.message || err) };
	}
});

ipcMain.handle('save-config', (e, config) => {
	const errors = builder.validateConfig(config);
	if (errors.length) return { ok: false, errors };
	fs.writeFileSync(CONFIG_PATH + '.tmp', JSON.stringify(config, null, 2) + '\n');
	fs.renameSync(CONFIG_PATH + '.tmp', CONFIG_PATH);
	return { ok: true };
});

ipcMain.handle('command', (e, line) => {
	if (!/^(status|reload|stop|start|mute|unmute|rescan|quit)\b/.test(line)) return { ok: false, error: 'unknown command' };
	if (!supervisorPid()) return { ok: false, error: 'supervisor not running' };
	fs.appendFileSync(cmdPath, line.trim() + '\n');
	return { ok: true };
});

ipcMain.handle('start-supervisor', () => {
	if (supervisorPid()) return { ok: true, adopted: true };
	const config = readJson(CONFIG_PATH);
	if (!config) return { ok: false, error: 'sources.json missing or unparsable' };
	const errors = builder.validateConfig(config);
	if (errors.length) return { ok: false, error: errors.join('; ') };
	// Fully detached: no pipes, unref'd — console death cannot reach the supervisor.
	// ELECTRON_RUN_AS_NODE turns this Electron binary into plain Node for supervisor.js
	// (the supervisor strips the var before spawning its electron.exe workers).
	const child = spawn(process.execPath, [path.join(__dirname, 'supervisor.js'), `--config=${CONFIG_PATH}`], {
		detached: true,
		stdio: 'ignore',
		windowsHide: true,
		env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
	});
	child.unref();
	return { ok: true, pid: child.pid };
});

app.whenReady().then(() => {
	// Operator console: always expose the full accessibility tree (screen readers,
	// UI automation). Cost is negligible at this page size.
	app.setAccessibilitySupportEnabled(true);
	const win = new BrowserWindow({
		width: 1280,
		height: 860,
		title: 'Capture Console',
		webPreferences: {
			preload: path.join(__dirname, 'console-preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	win.removeMenu();
	win.loadFile(path.join(__dirname, 'console.html'));
	mainWin = win;
	// closing the console window closes its pop-outs too (they are children in
	// spirit; without this, window-all-closed never fires while a pop-out lives)
	win.on('closed', popoutsShutdown);
	previews.init();
	previewSync();
	meterSync();
	// Reconcile receivers + meter helpers to config + toggles: picks up
	// sources.json edits (add/remove/endpoint change) without renderer involvement.
	// muteSync re-asserts mute/solo intent on workers that restarted unmuted.
	setInterval(() => { previewSync(); meterSync(); muteSync(false); popoutSync(); }, 2000);
});

app.on('before-quit', () => { previews.shutdown(); metersShutdown(); });
app.on('window-all-closed', () => app.quit()); // workers live on — file-coupled only
