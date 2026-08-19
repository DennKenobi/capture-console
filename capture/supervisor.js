// Supervisor — Capture Console fork, Phase 1 (ARCHITECTURE.md §2, SESSION4-SPEC §3.4).
// Headless, plain Node. Spawns one Electron worker process per plane per player (Model B),
// sequenced startup, JSON-line status uplink, restart-with-backoff, per-plane reload via
// stdin. There is deliberately NO way to change a parameter of a running worker — every
// change is kill + respawn from config (the immutability invariant, KICKOFF §6).
//
//   node capture/supervisor.js --config=path/to/sources.json
//       [--source=<name>] [--plane=video|audio] [--log=<file>] [--status-json]
//
// stdin commands: status | reload <player> <plane> | stop <player> <plane>
//                 | start <player> <plane> | mute <player> [audio]
//                 | unmute <player> [audio] | rescan | quit
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const builder = require('./url-builder');

function argOf(name, dflt) {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : dflt;
}

const CONFIG_PATH = argOf('config', '');
const ONLY_SOURCE = argOf('source', '');
const ONLY_PLANE = argOf('plane', '');
const SUP_STATUS_JSON = process.argv.includes('--status-json');
if (!CONFIG_PATH) { console.error('--config=<path> is required'); process.exit(2); }

const REPO_ROOT = path.resolve(__dirname, '..');
const ELECTRON_EXE = process.platform === 'win32'
	? path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
	: path.join(REPO_ROOT, 'node_modules', '.bin', 'electron');
const READY_TIMEOUT_MS = 90000;
const RESTART_BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];
// Page-load failures (worker exit code 4) churn whole process trees and cluster
// exactly when the box is saturated — back off much harder (Session 4 storm lesson).
const LOADFAIL_BACKOFF_MS = [15000, 30000, 60000, 120000, 300000];
const EXIT_LOAD_FAILED = 4;
const MAX_RESTARTS = 5;
// FAILED is not terminal: storms end. Retry a failed worker every 5 min, forever,
// logging each attempt (Session 4 storm lesson; SESSION5-SPEC Part C carry-in).
const FAILED_RETRY_MS = 300000;
const HEALTHY_RESET_MS = 120000;

const configDir = path.dirname(path.resolve(CONFIG_PATH));
const dataRoot = path.join(configDir, '.workers');
const logPath = argOf('log', path.join(configDir, 'supervisor.log'));
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

// The console spawns us detached and may die/restart at will; our stdout pipe can
// break mid-write. Never let EPIPE kill the workers' supervisor.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// Single-instance guard + discovery handle for the console (file-based adoption).
const pidPath = path.join(configDir, 'supervisor.pid');
function pidFileAlive() {
	try {
		const other = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
		if (other && other !== process.pid) { process.kill(other, 0); return other; }
	} catch {}
	return 0;
}
{
	const other = pidFileAlive();
	if (other) {
		console.error(`[sup] another supervisor (pid ${other}) already owns ${CONFIG_PATH} — exiting`);
		process.exit(3);
	}
	fs.writeFileSync(pidPath, String(process.pid));
}

function ts() { return new Date().toISOString().slice(11, 23); }
function log(line, consoleToo = true) {
	const msg = `${ts()} ${line}`;
	logStream.write(msg + '\n');
	if (consoleToo) console.log(msg);
}
function emitSup(ev, extra) {
	if (SUP_STATUS_JSON) console.log(JSON.stringify(Object.assign({ ev, sup: true }, extra || {})));
}

let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const configErrors = builder.validateConfig(config);
if (configErrors.length) {
	console.error('sources.json invalid:');
	for (const e of configErrors) console.error('  - ' + e);
	try { fs.unlinkSync(pidPath); } catch {}
	process.exit(2);
}

// ---- worker table ---------------------------------------------------------
// state: idle | starting | running | backoff | stopped | failed
const workers = new Map(); // key "player/plane"

// Video topology (Session 5 Part A bench, 2026-08-18): "consolidated" = ONE
// video-host.js process hosting every player's surface — DEFAULT (3.2 vs 5.3 cores,
// 10 vs 33 processes, 2.3 vs 5.7 GB against per-player at the 6-source bench mix;
// fps content-rate-equal under normal load). "per-player" = one slice-main.js
// process per player (full isolation) — remains available per config/CLI.
// Audio workers are identical in both.
const VIDEO_TOPOLOGY = argOf('video-topology',
	(config.defaults && config.defaults.videoTopology) || 'consolidated');
const VIDEOHOST_KEY = 'videohost/video';

function workerSpecs() {
	const specs = [];
	if ((!ONLY_PLANE || ONLY_PLANE === 'video') && VIDEO_TOPOLOGY === 'consolidated') {
		const args = [
			`--config=${path.resolve(CONFIG_PATH)}`,
			`--user-data-dir=${path.join(dataRoot, 'video-host')}`,
			'--status-json',
		];
		if (ONLY_SOURCE) args.push(`--source=${ONLY_SOURCE}`);
		if (config.defaults && config.defaults.video && config.defaults.video.ndiDepth) {
			args.push(`--ndi-depth=${config.defaults.video.ndiDepth}`);
		}
		// Session 6: 'native' (video-host default — shared-texture readback module,
		// falls back to inline in-host if the binary won't load) | 'inline' |
		// 'proc' (rejected, kept for re-testing). CLI --video-sender overrides config.
		const senderMode = argOf('video-sender',
			config.defaults && config.defaults.video && config.defaults.video.senderMode);
		if (senderMode) args.push(`--sender=${senderMode}`);
		specs.push({
			key: VIDEOHOST_KEY, player: 'videohost', plane: 'video', consolidated: true,
			entry: path.join(__dirname, 'video-host.js'),
			args,
		});
	}
	for (const source of config.sources) {
		if (ONLY_SOURCE && source.name !== ONLY_SOURCE) continue;
		const v = builder.resolveVideo(source, config.defaults);
		if ((!ONLY_PLANE || ONLY_PLANE === 'video') && VIDEO_TOPOLOGY !== 'consolidated') {
			specs.push({
				key: `${source.name}/video`, player: source.name, plane: 'video',
				entry: path.join(__dirname, 'slice-main.js'),
				args: [
					`--url=${builder.videoUrl(source, config.defaults)}`,
					`--ndi-name=${builder.ndiName(source, config.defaults)}`,
					`--width=${v.width}`, `--height=${v.height}`, `--fps=${v.fps}`,
					`--user-data-dir=${path.join(dataRoot, `${source.name}-video`)}`,
					'--status-json',
				],
			});
		}
		if (!ONLY_PLANE || ONLY_PLANE === 'audio') {
			specs.push({
				key: `${source.name}/audio`, player: source.name, plane: 'audio',
				entry: path.join(__dirname, 'audio-main.js'),
				args: [
					`--url=${builder.audioUrl(source, config.defaults)}`,
					`--user-data-dir=${path.join(dataRoot, `${source.name}-audio`)}`,
					'--status-json',
				],
			});
		}
	}
	return specs;
}

function getWorker(key) {
	return workers.get(key);
}

function spawnWorker(w) {
	w.state = 'starting';
	w.startedAt = Date.now();
	w.requestedStop = false;
	w.muted = false; // a fresh page starts unmuted; the console re-asserts intent
	// The console runs us under ELECTRON_RUN_AS_NODE; that var must NOT reach the
	// electron.exe workers or they would boot as plain Node.
	const env = Object.assign({}, process.env);
	delete env.ELECTRON_RUN_AS_NODE;
	const child = spawn(ELECTRON_EXE, [w.spec.entry, ...w.spec.args], {
		// Consolidated video host takes per-player commands on stdin.
		stdio: [w.spec.consolidated ? 'pipe' : 'ignore', 'pipe', 'pipe'],
		windowsHide: true,
		env,
	});
	w.child = child;
	w.pid = child.pid;
	log(`[sup] spawn ${w.spec.key} pid=${child.pid}`);
	emitSup('spawn', { key: w.spec.key, pid: child.pid });

	const onLine = line => {
		if (!line.trim()) return;
		logStream.write(`${ts()} [${w.spec.key}] ${line}\n`);
		if (line.startsWith('{')) {
			try {
				const ev = JSON.parse(line);
				handleWorkerEvent(w, ev);
			} catch { /* not a status line */ }
		}
	};
	readline.createInterface({ input: child.stdout }).on('line', onLine);
	readline.createInterface({ input: child.stderr }).on('line', l => logStream.write(`${ts()} [${w.spec.key}!] ${l}\n`));

	child.on('exit', (code, signal) => handleWorkerExit(w, code, signal));

	w.readyTimer = setTimeout(() => {
		if (w.state === 'starting') {
			log(`[sup] WARN ${w.spec.key} not loaded after ${READY_TIMEOUT_MS / 1000}s (continuing to wait)`);
		}
	}, READY_TIMEOUT_MS);
}

function handleWorkerEvent(w, ev) {
	// Consolidated host: per-player events are recorded per player; only host-level
	// events drive the worker's own lifecycle state.
	if (w.spec.consolidated && ev.player && ev.player !== 'videohost') {
		w.playerStats = w.playerStats || {};
		if (ev.ev === 'stats') {
			w.playerStats[ev.player] = Object.assign({}, w.playerStats[ev.player], ev, { at: Date.now() });
		} else {
			w.playerStats[ev.player] = Object.assign({}, w.playerStats[ev.player], { lastEv: ev.ev, at: Date.now() });
			log(`[sup] videohost/${ev.player}: ${ev.ev}${ev.reason ? ` (${ev.reason})` : ''}`);
			emitSup(`vhost-${ev.ev}`, { player: ev.player, reason: ev.reason });
		}
		if (ev.ev !== 'host-loaded') return;
	}
	switch (ev.ev) {
		case 'ready':
			log(`[sup] ${w.spec.key} ready${ev.ndiName ? ` (ndi=${ev.ndiName})` : ''}`);
			break;
		case 'host-loaded':
		case 'loaded':
			w.state = 'running';
			clearTimeout(w.readyTimer);
			clearTimeout(w.failedTimer);
			log(`[sup] ${w.spec.key} loaded`);
			emitSup('loaded', { key: w.spec.key });
			if (w.loadedResolve) { w.loadedResolve(); w.loadedResolve = null; }
			// a worker that stays alive resets its restart budget
			w.healthyTimer = setTimeout(() => { w.restarts = 0; }, HEALTHY_RESET_MS);
			break;
		case 'stats':
			w.lastStats = ev;
			w.lastStatsAt = Date.now();
			// audio workers report muted in stats too — recovers a missed 'muted' line
			if (typeof ev.muted === 'boolean') w.muted = ev.muted;
			break;
		case 'muted':
			w.muted = !!ev.muted;
			log(`[sup] ${w.spec.key} page mute -> ${w.muted}`);
			emitSup('muted', { key: w.spec.key, muted: w.muted });
			break;
		case 'exiting':
			log(`[sup] ${w.spec.key} exiting (${ev.reason})`);
			break;
	}
}

function handleWorkerExit(w, code, signal) {
	clearTimeout(w.readyTimer);
	clearTimeout(w.healthyTimer);
	const uptime = Math.round((Date.now() - w.startedAt) / 1000);
	log(`[sup] ${w.spec.key} exited code=${code} signal=${signal} uptime=${uptime}s`);
	emitSup('worker-exit', { key: w.spec.key, code, signal, uptime });
	w.child = null;
	if (w.loadedResolve) { w.loadedResolve(); w.loadedResolve = null; }

	if (shuttingDown || w.requestedStop) { w.state = 'stopped'; return; }

	if (w.restarts >= MAX_RESTARTS) {
		// Not terminal: storms end. Hold a 5-min cooldown, then try again, forever.
		w.state = 'failed';
		log(`[sup] ${w.spec.key} FAILED after ${w.restarts} restarts — cooldown ${FAILED_RETRY_MS / 60000} min, then retry (siblings unaffected)`);
		emitSup('worker-failed', { key: w.spec.key, restarts: w.restarts });
		w.failedTimer = setTimeout(() => {
			log(`[sup] ${w.spec.key} FAILED-cooldown retry (attempt ${w.restarts + 1} lifetime)`);
			emitSup('failed-retry', { key: w.spec.key });
			w.restarts++;
			spawnWorker(w);
		}, FAILED_RETRY_MS);
		return;
	}
	// Load failures churn full process trees and cluster under saturation — harder ladder.
	const ladder = code === EXIT_LOAD_FAILED ? LOADFAIL_BACKOFF_MS : RESTART_BACKOFF_MS;
	const delay = ladder[Math.min(w.restarts, ladder.length - 1)];
	w.restarts++;
	w.state = 'backoff';
	log(`[sup] ${w.spec.key} restart ${w.restarts}/${MAX_RESTARTS} in ${delay / 1000}s${code === EXIT_LOAD_FAILED ? ' (load-fail ladder)' : ''}`);
	w.backoffTimer = setTimeout(() => spawnWorker(w), delay);
}

function waitLoaded(w) {
	return new Promise(resolve => {
		if (w.state === 'running') return resolve();
		w.loadedResolve = resolve;
	});
}

async function stopWorker(w, why) {
	w.requestedStop = true;
	clearTimeout(w.backoffTimer);
	clearTimeout(w.failedTimer);
	if (!w.child) { w.state = 'stopped'; return; }
	log(`[sup] stopping ${w.spec.key} (${why})`);
	const exited = new Promise(resolve => w.child.once('exit', resolve));
	w.child.kill();
	await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
	if (w.child) { try { w.child.kill('SIGKILL'); } catch {} }
	w.state = 'stopped';
}

// ---- lifecycle ------------------------------------------------------------

let shuttingDown = false;

async function bringUp() {
	const specs = workerSpecs();
	log(`[sup] config ok: ${config.sources.length} source(s) -> ${specs.length} worker(s); data root ${dataRoot}`);
	for (const spec of specs) {
		const w = { spec, state: 'idle', restarts: 0, requestedStop: false, child: null };
		workers.set(spec.key, w);
	}
	// Sequenced startup: one at a time, wait for load-complete (KICKOFF §5).
	for (const [, w] of workers) {
		spawnWorker(w);
		await Promise.race([waitLoaded(w), new Promise(r => setTimeout(r, READY_TIMEOUT_MS))]);
		if (w.state !== 'running') log(`[sup] WARN ${w.spec.key} did not reach loaded before timeout; continuing bring-up`);
	}
	log('[sup] bring-up complete');
	emitSup('bringup-complete', { workers: [...workers.values()].map(w => ({ key: w.spec.key, state: w.state })) });
}

async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	log('[sup] shutting down all workers');
	await Promise.all([...workers.values()].map(w => stopWorker(w, 'shutdown')));
	log('[sup] shutdown complete');
	writeStatusFile();
	try { fs.unlinkSync(pidPath); } catch {}
	logStream.end();
	process.exit(0);
}

// ---- status file (console coupling; atomic tmp+rename) --------------------
const statusPath = path.join(configDir, 'supervisor-status.json');
function writeStatusFile() {
	const snapshot = {
		pid: process.pid,
		at: Date.now(),
		configPath: path.resolve(CONFIG_PATH),
		videoTopology: VIDEO_TOPOLOGY,
		shuttingDown,
		workers: [...workers.values()].map(w => ({
			key: w.spec.key,
			player: w.spec.player,
			plane: w.spec.plane,
			consolidated: !!w.spec.consolidated,
			state: w.state,
			pid: w.child ? w.pid : null,
			restarts: w.restarts,
			muted: !!w.muted,
			lastStats: w.lastStats || null,
			lastStatsAt: w.lastStatsAt || null,
			playerStats: w.playerStats || null,
		})),
	};
	try {
		fs.writeFileSync(statusPath + '.tmp', JSON.stringify(snapshot));
		fs.renameSync(statusPath + '.tmp', statusPath);
	} catch { /* console just sees a stale tick */ }
}
setInterval(writeStatusFile, 2000);

// ---- rescan: reconcile the worker table to the config file on disk --------
// Adds new players' workers, stops+removes deleted ones, refreshes every spec so
// the next reload/restart of an existing worker picks up edited parameters.
// Siblings are never touched (KICKOFF Phase 2: add/remove without disturbance).
async function rescan() {
	let fresh;
	try { fresh = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (err) {
		log(`[sup] RESCAN rejected: config unreadable (${err.message})`);
		return;
	}
	const errors = builder.validateConfig(fresh);
	if (errors.length) {
		log(`[sup] RESCAN rejected: ${errors.join('; ')}`);
		return;
	}
	config = fresh;
	const specs = workerSpecs();
	const wanted = new Map(specs.map(s => [s.key, s]));
	// refresh specs of existing workers; collect newcomers
	const newcomers = [];
	for (const spec of specs) {
		const w = workers.get(spec.key);
		if (w) { w.spec = spec; } else { newcomers.push(spec); }
	}
	// stop and drop workers whose player left the config
	for (const [key, w] of [...workers]) {
		if (!wanted.has(key)) {
			log(`[sup] RESCAN removing ${key}`);
			emitSup('rescan-remove', { key });
			await stopWorker(w, 'rescan-remove');
			workers.delete(key);
		}
	}
	// consolidated host reconciles its own windows from the same file
	if (workers.has(VIDEOHOST_KEY)) {
		log('[sup] RESCAN forwarding to videohost');
		forwardToVideohost('rescan');
	}
	// spawn newcomers sequenced (video-plane first is preserved by spec order)
	for (const spec of newcomers) {
		log(`[sup] RESCAN adding ${spec.key}`);
		emitSup('rescan-add', { key: spec.key });
		const w = { spec, state: 'idle', restarts: 0, requestedStop: false, child: null };
		workers.set(spec.key, w);
		spawnWorker(w);
		await Promise.race([waitLoaded(w), new Promise(r => setTimeout(r, READY_TIMEOUT_MS))]);
	}
	log('[sup] RESCAN complete');
	emitSup('rescan-complete', {});
}

function statusReport() {
	for (const [, w] of workers) {
		const stats = w.lastStats
			? Object.entries(w.lastStats).filter(([k]) => !['ev', 'plane'].includes(k)).map(([k, v]) => `${k}=${v}`).join(' ')
			: '';
		console.log(`  ${w.spec.key.padEnd(20)} ${w.state.padEnd(9)} pid=${String(w.pid || '-').padEnd(7)} restarts=${w.restarts} ${stats}`);
		if (w.spec.consolidated && w.playerStats) {
			for (const [player, ps] of Object.entries(w.playerStats)) {
				const line = Object.entries(ps).filter(([k]) => !['ev', 'plane', 'player', 'at'].includes(k)).map(([k, v]) => `${k}=${v}`).join(' ');
				console.log(`    · ${player.padEnd(16)} ${line}`);
			}
		}
	}
}

async function handleCommand(line) {
	const [cmd, player, plane] = line.trim().split(/\s+/);
	if (!cmd) return;
	if (cmd === 'quit') return shutdown();
	if (cmd === 'status') return statusReport();
	// mute/unmute: app-layer page mute on the audio worker (SESSION8-SPEC §2) —
	// forwarded to the worker's polled audio.cmd file, never a worker rebuild.
	if (cmd === 'mute' || cmd === 'unmute') {
		if (plane && plane !== 'audio') return console.log(`${cmd} applies to the audio plane only`);
		const w = getWorker(`${player}/audio`);
		if (!w) return console.log(`unknown worker: ${player}/audio`);
		log(`[sup] ${cmd.toUpperCase()} ${player}/audio`);
		emitSup(cmd, { key: w.spec.key });
		forwardToAudioWorker(w, cmd);
		return;
	}
	if (['reload', 'stop', 'start'].includes(cmd)) {
		const key = `${player}/${plane}`;
		let w = getWorker(key);
		// Consolidated topology: a player's video plane is a window inside the host —
		// forward the command to video-host (window rebuild; NDI sender kept, so no
		// name-linger penalty). Forwarding is via the polled vhost.cmd file — a piped
		// stdin into an Electron main process is not readable on Windows.
		// `<cmd> videohost video` still operates on the host process itself.
		if (!w && plane === 'video' && VIDEO_TOPOLOGY === 'consolidated') {
			const host = getWorker(VIDEOHOST_KEY);
			if (host && host.child) {
				log(`[sup] forwarding to videohost: ${cmd} ${player}`);
				emitSup('vhost-forward', { cmd, player });
				forwardToVideohost(`${cmd} ${player}`);
				return;
			}
			return console.log(`videohost not running; cannot ${cmd} ${player}/video`);
		}
		if (!w) return console.log(`unknown worker: ${key}`);
		if (cmd === 'stop') return void stopWorker(w, 'stdin');
		if (cmd === 'start') { w.restarts = 0; return void spawnWorker(w); }
		// reload = the sanctioned change mechanism: kill + respawn from CURRENT config
		// (spec refreshed from disk so console edits like channelOffset apply).
		log(`[sup] RELOAD ${key} requested`);
		emitSup('reload-begin', { key });
		try {
			const fresh = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
			if (!builder.validateConfig(fresh).length) {
				config = fresh;
				const spec = workerSpecs().find(s => s.key === w.spec.key);
				if (spec) w.spec = spec;
			}
		} catch { /* keep the old spec if the file is mid-edit */ }
		await stopWorker(w, 'reload');
		w.restarts = 0;
		spawnWorker(w);
		return;
	}
	if (cmd === 'rescan') return void rescan();
	console.log('commands: status | reload <player> <plane> | stop <player> <plane> | start <player> <plane> | mute <player> [audio] | unmute <player> [audio] | rescan | quit');
}

readline.createInterface({ input: process.stdin }).on('line', handleCommand);

// File-based command channel for detached/unattended operation: append lines to
// <config-dir>/supervisor.cmd; they are executed and the file truncated.
// Video-host command forwarding: append to the file video-host polls.
function forwardToVideohost(line) {
	try { fs.appendFileSync(path.join(configDir, 'vhost.cmd'), line + '\n'); } catch (err) {
		log(`[sup] vhost forward failed: ${err.message}`);
	}
}

// Audio-worker command forwarding (Session 8: mute/unmute only): append to the
// audio.cmd file inside the worker's data dir — same polled-file pattern.
function forwardToAudioWorker(w, line) {
	const dirArg = w.spec.args.find(a => a.startsWith('--user-data-dir='));
	if (!dirArg) return log(`[sup] ${w.spec.key} has no data dir; cannot forward ${line}`);
	const dir = dirArg.split('=').slice(1).join('=');
	try { fs.appendFileSync(path.join(dir, 'audio.cmd'), line + '\n'); } catch (err) {
		log(`[sup] audio forward failed (${w.spec.key}): ${err.message}`);
	}
}

const cmdFile = path.join(configDir, 'supervisor.cmd');
setInterval(() => {
	let text;
	try { text = fs.readFileSync(cmdFile, 'utf8'); } catch { return; }
	if (!text.trim()) return;
	try { fs.writeFileSync(cmdFile, ''); } catch {}
	for (const line of text.split(/\r?\n/)) {
		if (line.trim()) { log(`[sup] cmd-file: ${line.trim()}`); handleCommand(line); }
	}
}, 2000);

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

fs.mkdirSync(dataRoot, { recursive: true });
bringUp().catch(err => { console.error('[sup] FATAL', err); process.exit(1); });
