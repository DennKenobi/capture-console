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

const { app, BrowserWindow, dialog, ipcMain } = require('electron');
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

// Scene = a sources.json (Session 10 Part A). The console can switch scenes at
// runtime; every coupling path derives from the CURRENT scene file, and the
// supervisor coupling files live beside it (one supervisor per scene dir).
let configPath = path.resolve(argOf('config', path.join(__dirname, 'sources.json')));
let configDir = path.dirname(configPath);
let pidPath = path.join(configDir, 'supervisor.pid');
let cmdPath = path.join(configDir, 'supervisor.cmd');
let statusPath = path.join(configDir, 'supervisor-status.json');

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

// The status snapshot of THIS scene's supervisor — null when the supervisor is
// gone, stale (wedged), or running a DIFFERENT scene that shares this folder
// (coupling files are per-dir; a mismatched supervisor is not ours to command,
// mute against, or misroute-evaluate).
function ourStatus() {
	if (!supervisorPid()) return null;
	const status = readJson(statusPath);
	if (!status || Date.now() - status.at > 8000) return null;
	if (status.configPath && path.resolve(status.configPath) !== configPath) return null;
	return status;
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
	const config = readJson(configPath);
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
	const config = readJson(configPath);
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

// Session 10: configured device strings that are the same physical endpoint
// (normalize-substring relation — a fragment vs the dropdown's full label)
// collapse onto one representative: one meter helper per PHYSICAL endpoint,
// one grid group, meter IPC keyed consistently. First-seen fragment wins as
// the representative; the map ships to the renderer in `state`.
function deviceCanon() {
	const config = readJson(configPath);
	const canon = {};
	if (config && Array.isArray(config.sources)) {
		const defDev = (config.defaults && config.defaults.audio && config.defaults.audio.audioOutputDevice) || '';
		const reps = [];
		for (const s of config.sources) {
			const dev = (s.audio && s.audio.audioOutputDevice) || defDev;
			if (!dev || canon[dev]) continue;
			const rep = reps.find(r => builder.sameDevice(r, dev));
			canon[dev] = rep || dev;
			if (!rep) reps.push(dev);
		}
	}
	return canon;
}

function meterEndpoints() {
	const config = readJson(configPath);
	const out = new Set();
	if (config && config.sources && !builder.validateConfig(config).length) {
		const canon = deviceCanon();
		const defDev = (config.defaults && config.defaults.audio && config.defaults.audio.audioOutputDevice) || '';
		for (const s of config.sources) {
			const dev = (s.audio && s.audio.audioOutputDevice) || defDev;
			if (dev) out.add(canon[dev] || dev);
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

// ---- audio misroute detector (Session 10 Part C) ----------------------------
// vdo.ninja's &audiooutput can race device enumeration and silently fall back to
// the system default sink (Session 9, Player6). Verified discriminator (Session 10
// verify-early, capture/test/session-probe.ps1 — the spec's original "any session
// on the default endpoint" premise is FALSE: every healthy vdo.ninja page holds an
// active silent AudioContext session there):
//   MISROUTED  = worker tree owns ≥1 ACTIVE WASAPI session, but NONE on an
//                endpoint matching its configured fragment (vdo.ninja's own
//                normalize-substring rule).
//   A connected+routed worker's configured-endpoint session persists across
//   publisher disconnects; a never-connected worker owns no active session at
//   all — neither can false-flag.
// Read-only, console-side, zero worker contact: one misroute-stream.ps1 helper
// enumerates sessions + PID ancestry; workers are matched by root pid from
// supervisor-status.json. Flags need MISROUTE_CONFIRM_TICKS consecutive misses
// (covers the brief pre-sink window right after connect); any matching session,
// worker reload (fresh pid), or worker stop clears immediately.

const MISROUTE_BACKOFF_MS = [2000, 5000, 15000, 60000];
const MISROUTE_CONFIRM_TICKS = 3; // × 5 s helper cadence ≈ 15 s to confirm
let misrouteHelper = null;        // {child, backoffIdx, timer, retired}
let misrouteScan = null;          // latest helper line {default, sessions, at}
const misrouteMiss = new Map();   // player -> consecutive missing-session ticks
const misrouteState = new Map();  // player -> {actual, expected}

function misrouteEval() {
	const scan = misrouteScan;
	const status = ourStatus();
	const config = readJson(configPath);
	const next = new Map();
	if (scan && status && config && Array.isArray(config.sources)) {
		const defDev = (config.defaults && config.defaults.audio && config.defaults.audio.audioOutputDevice) || '';
		for (const w of status.workers) {
			if (w.plane !== 'audio' || w.consolidated || w.state !== 'running' || !w.pid) continue;
			const src = config.sources.find(s => s.name === w.player);
			if (!src) continue;
			const frag = (src.audio && src.audio.audioOutputDevice) || defDev;
			if (!frag) { misrouteMiss.delete(w.player); continue; } // default sink is intentional
			const tree = scan.sessions.filter(s => Array.isArray(s.chain) && s.chain.includes(w.pid));
			// no active session anywhere = page isn't rendering audio yet (never
			// connected) — that's "no incoming audio", not a misroute
			if (!tree.length) { misrouteMiss.delete(w.player); continue; }
			if (tree.some(s => builder.deviceMatches(frag, s.endpoint))) {
				misrouteMiss.delete(w.player);
				continue;
			}
			const misses = (misrouteMiss.get(w.player) || 0) + 1;
			misrouteMiss.set(w.player, misses);
			if (misses >= MISROUTE_CONFIRM_TICKS) {
				next.set(w.player, {
					actual: [...new Set(tree.map(s => s.endpoint))].join(', '),
					expected: frag,
				});
			}
		}
	}
	for (const [player, info] of next) {
		if (!misrouteState.has(player)) {
			console.log(`[misroute] ${player}: audio on "${info.actual}", expected "${info.expected}" — flag raised`);
		}
	}
	for (const player of misrouteState.keys()) {
		if (!next.has(player)) console.log(`[misroute] ${player}: cleared`);
	}
	misrouteState.clear();
	for (const [p, info] of next) misrouteState.set(p, info);
}

function spawnMisrouteHelper(entry) {
	entry.child = spawn('powershell.exe', [
		'-NoProfile', '-ExecutionPolicy', 'Bypass',
		'-File', path.join(__dirname, 'misroute-stream.ps1'),
		'-IntervalMs', '5000',
	], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
	require('readline').createInterface({ input: entry.child.stdout }).on('line', line => {
		let parsed;
		try { parsed = JSON.parse(line); } catch { return; }
		if (parsed.error) { console.log(`[misroute] helper: ${parsed.error}`); return; }
		entry.backoffIdx = 0; // healthy stream resets the ladder
		misrouteScan = Object.assign({}, parsed, { at: Date.now() });
		misrouteEval();
	});
	entry.child.on('exit', code => {
		entry.child = null;
		if (entry.retired) return;
		const delay = MISROUTE_BACKOFF_MS[Math.min(entry.backoffIdx, MISROUTE_BACKOFF_MS.length - 1)];
		entry.backoffIdx++;
		console.log(`[misroute] helper exited code=${code}; respawn in ${delay / 1000}s`);
		entry.timer = setTimeout(() => { if (!entry.retired) spawnMisrouteHelper(entry); }, delay);
	});
}

function misrouteShutdown() {
	if (!misrouteHelper) return;
	misrouteHelper.retired = true;
	clearTimeout(misrouteHelper.timer);
	if (misrouteHelper.child) { try { misrouteHelper.child.kill(); } catch {} }
	misrouteHelper = null;
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
	const status = ourStatus();
	if (!status) return;
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

// ---- scenes (Session 10 Part A) --------------------------------------------
// A scene IS a sources.json; New/Open/Save As re-point every coupling path at
// it. The 2 s reconcile loops (previews, meters, mute intent, pop-outs,
// misroute) all key off the current config, so a switch propagates on its own;
// console-local operator state is scene-local and resets here. Switching away
// from a RUNNING supervisor is never silent: the operator chooses
// stop-everything or leave-running (file coupling means reopening that scene
// later re-adopts the still-streaming workers).

function applyScene(p) {
	configPath = path.resolve(p);
	configDir = path.dirname(configPath);
	pidPath = path.join(configDir, 'supervisor.pid');
	cmdPath = path.join(configDir, 'supervisor.cmd');
	statusPath = path.join(configDir, 'supervisor-status.json');
	muteIntent.clear();
	soloPlayer = null;
	muteCmdAt.clear();
	previewRowOff.clear();
	misrouteMiss.clear();
	misrouteState.clear();
	popoutsShutdown();
	previewSync();
	meterSync();
	console.log(`[scene] now on ${configPath}`);
}

// 'go' | 'cancel' | an error string. Only guards OUR scene's supervisor — one
// running a different scene in a shared folder was never ours to stop.
async function confirmSupervisorHandover() {
	const pid = supervisorPid();
	if (!pid) return 'go';
	const status = readJson(statusPath);
	if (status && status.configPath && path.resolve(status.configPath) !== configPath) return 'go';
	const cur = path.basename(configPath);
	const { response } = await dialog.showMessageBox(mainWin, {
		type: 'question',
		title: 'Supervisor is running',
		message: `A supervisor (pid ${pid}) is running ${cur}.`,
		detail: 'Stop everything, then switch: every worker stops and the NDI streams end '
			+ 'before the new scene opens.\n\nLeave running and switch: '
			+ `${cur}'s workers keep streaming unattended (file-coupled, no console needed); `
			+ 'reopening that scene later re-adopts them.',
		buttons: ['Stop everything, then switch', 'Leave running and switch', 'Cancel'],
		defaultId: 0,
		cancelId: 2,
		noLink: true,
	});
	if (response === 2) return 'cancel';
	if (response === 1) {
		console.log(`[scene] leaving supervisor pid ${pid} running on ${configPath}`);
		return 'go';
	}
	try { fs.appendFileSync(cmdPath, 'quit\n'); } catch (err) { return `stop failed: ${err.message}`; }
	console.log(`[scene] quit sent to supervisor pid ${pid}; waiting for shutdown`);
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		if (!supervisorPid()) return 'go';
		await new Promise(r => setTimeout(r, 500));
	}
	return 'supervisor has not stopped yet (workers still shutting down?) — scene unchanged, try again shortly';
}

const SCENE_FILTERS = [{ name: 'Scene (sources.json)', extensions: ['json'] }];

ipcMain.handle('scene-new', async () => {
	const res = await dialog.showSaveDialog(mainWin, {
		title: 'New scene',
		defaultPath: path.join(configDir, 'new-scene.json'),
		filters: SCENE_FILTERS,
	});
	if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
	const guard = await confirmSupervisorHandover();
	if (guard === 'cancel') return { ok: false, cancelled: true };
	if (guard !== 'go') return { ok: false, error: guard };
	// a fresh scene starts EMPTY (valid since Session 9) but inherits the current
	// defaults — same studio, same endpoints, same prefix
	const cur = readJson(configPath);
	const fresh = { defaults: (cur && cur.defaults) || {}, sources: [] };
	try { fs.writeFileSync(res.filePath, JSON.stringify(fresh, null, 2) + '\n'); } catch (err) {
		return { ok: false, error: `could not write scene: ${err.message}` };
	}
	applyScene(res.filePath);
	return { ok: true, path: configPath };
});

ipcMain.handle('scene-open', async () => {
	const res = await dialog.showOpenDialog(mainWin, {
		title: 'Open scene',
		defaultPath: configDir,
		filters: SCENE_FILTERS,
		properties: ['openFile'],
	});
	if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, cancelled: true };
	const target = path.resolve(res.filePaths[0]);
	if (target === configPath) return { ok: true, path: configPath, unchanged: true };
	let parsed;
	try { parsed = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (err) {
		return { ok: false, error: `not a readable scene: ${err.message}` };
	}
	// validation problems don't block opening (the editor is where you fix them) —
	// they ride back as warnings
	const warnings = builder.validateConfig(parsed);
	const guard = await confirmSupervisorHandover();
	if (guard === 'cancel') return { ok: false, cancelled: true };
	if (guard !== 'go') return { ok: false, error: guard };
	applyScene(target);
	return { ok: true, path: configPath, warnings };
});

ipcMain.handle('scene-saveas', async () => {
	let raw;
	try { raw = fs.readFileSync(configPath); } catch (err) {
		return { ok: false, error: `current scene unreadable: ${err.message}` };
	}
	const res = await dialog.showSaveDialog(mainWin, {
		title: 'Save scene as',
		defaultPath: path.join(configDir, 'copy-of-' + path.basename(configPath)),
		filters: SCENE_FILTERS,
	});
	if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
	const target = path.resolve(res.filePath);
	if (target === configPath) return { ok: true, path: configPath, unchanged: true };
	const guard = await confirmSupervisorHandover();
	if (guard === 'cancel') return { ok: false, cancelled: true };
	if (guard !== 'go') return { ok: false, error: guard };
	try { fs.writeFileSync(target, raw); } catch (err) {
		return { ok: false, error: `could not write scene: ${err.message}` };
	}
	applyScene(target);
	return { ok: true, path: configPath };
});

// ---- IPC surface ----------------------------------------------------------

ipcMain.handle('state', () => {
	const config = readJson(configPath);
	const pid = supervisorPid();
	const rawStatus = pid ? readJson(statusPath) : null;
	// coupling files are per-dir: a supervisor here running a DIFFERENT scene is
	// not ours — surface the mismatch instead of impersonating adoption
	const mismatch = !!(rawStatus && rawStatus.configPath
		&& path.resolve(rawStatus.configPath) !== configPath);
	return {
		configPath: configPath,
		sceneName: path.basename(configPath),
		sceneMismatch: mismatch ? path.basename(rawStatus.configPath) : '',
		config,
		configErrors: config ? builder.validateConfig(config) : ['sources.json missing or unparsable'],
		deviceCanon: deviceCanon(),
		supervisorPid: pid,
		// a status snapshot older than 8 s means the supervisor is wedged or gone
		status: ourStatus(),
		previews: {
			available: !previews.unavailable,
			reason: previews.unavailable || '',
			global: previewGlobal,
			rowOff: [...previewRowOff],
			states: previews.states(),
		},
		audioMix: { solo: soloPlayer, muted: [...muteIntent] },
		popouts: [...popouts.keys()],
		misroute: {
			players: Object.fromEntries(misrouteState),
			// stale scan = helper down; flags shown are last-known, not live
			fresh: !!(misrouteScan && Date.now() - misrouteScan.at < 15000),
		},
	};
});

ipcMain.handle('popout-toggle', (e, player) => ({ ok: true, open: popoutToggle(player) }));

// Render-endpoint list for the editor's device dropdown (Session 9): one-shot
// PowerShell enumeration with channel counts (the operator's real question is
// "which endpoint has 8 channels"), cached briefly — devices rarely change mid-edit.
let endpointCache = { at: 0, data: null };
ipcMain.handle('audio-devices', async () => {
	if (endpointCache.data && Date.now() - endpointCache.at < 10000) return endpointCache.data;
	const data = await new Promise(resolve => {
		require('child_process').execFile('powershell.exe', [
			'-NoProfile', '-ExecutionPolicy', 'Bypass',
			'-File', path.join(__dirname, 'list-endpoints.ps1'),
		], { timeout: 20000, windowsHide: true }, (err, stdout) => {
			if (err) return resolve({ error: String(err.message || err), default: '', devices: [] });
			try { resolve(JSON.parse(stdout)); } catch { resolve({ error: 'enumeration output unparsable', default: '', devices: [] }); }
		});
	});
	endpointCache = { at: Date.now(), data };
	return data;
});

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
	fs.writeFileSync(configPath + '.tmp', JSON.stringify(config, null, 2) + '\n');
	fs.renameSync(configPath + '.tmp', configPath);
	return { ok: true };
});

ipcMain.handle('command', (e, line) => {
	if (!/^(status|reload|stop|start|mute|unmute|rescan|quit)\b/.test(line)) return { ok: false, error: 'unknown command' };
	if (!supervisorPid()) return { ok: false, error: 'supervisor not running' };
	const status = readJson(statusPath);
	if (status && status.configPath && path.resolve(status.configPath) !== configPath) {
		return { ok: false, error: `the supervisor in this folder runs a different scene (${path.basename(status.configPath)})` };
	}
	fs.appendFileSync(cmdPath, line.trim() + '\n');
	return { ok: true };
});

ipcMain.handle('start-supervisor', () => {
	if (supervisorPid()) {
		const status = readJson(statusPath);
		if (status && status.configPath && path.resolve(status.configPath) !== configPath) {
			return {
				ok: false,
				error: `a supervisor in this folder is running a different scene (${path.basename(status.configPath)}) — one supervisor per scene folder`,
			};
		}
		return { ok: true, adopted: true };
	}
	const config = readJson(configPath);
	if (!config) return { ok: false, error: 'sources.json missing or unparsable' };
	const errors = builder.validateConfig(config);
	if (errors.length) return { ok: false, error: errors.join('; ') };
	// Fully detached: no pipes, unref'd — console death cannot reach the supervisor.
	// ELECTRON_RUN_AS_NODE turns this Electron binary into plain Node for supervisor.js
	// (the supervisor strips the var before spawning its electron.exe workers).
	const child = spawn(process.execPath, [path.join(__dirname, 'supervisor.js'), `--config=${configPath}`], {
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
		title: 'ECANDI',
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
	misrouteHelper = { child: null, backoffIdx: 0, timer: null, retired: false };
	spawnMisrouteHelper(misrouteHelper);
	// Reconcile receivers + meter helpers to config + toggles: picks up
	// sources.json edits (add/remove/endpoint change) without renderer involvement.
	// muteSync re-asserts mute/solo intent on workers that restarted unmuted.
	setInterval(() => { previewSync(); meterSync(); muteSync(false); popoutSync(); }, 2000);
});

app.on('before-quit', () => { previews.shutdown(); metersShutdown(); misrouteShutdown(); });
app.on('window-all-closed', () => app.quit()); // workers live on — file-coupled only
