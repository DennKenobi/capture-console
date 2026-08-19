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

function argOf(name, dflt) {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : dflt;
}

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
	};
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
	if (!/^(status|reload|stop|start|rescan|quit)\b/.test(line)) return { ok: false, error: 'unknown command' };
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
});

app.on('window-all-closed', () => app.quit()); // workers live on — file-coupled only
