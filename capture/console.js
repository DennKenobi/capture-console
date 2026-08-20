// Console renderer — Capture Console fork, Session 5 Part C.
// Polls main for state every 2 s; all mutation goes through sources.json edits +
// supervisor commands (immutability invariant: nothing mutates a live worker).
'use strict';

const $ = id => document.getElementById(id);
let lastState = null;
let editing = null; // null = closed, '' = new player, 'Name' = editing that player

function setMsg(text) { $('msg').textContent = text || ''; }

function fmtStats(st) {
	if (!st) return '';
	const bits = [];
	if (st.paintFps !== undefined) bits.push(`${st.paintFps} paint-fps`);
	if (st.sent !== undefined) bits.push(`sent ${st.sent}`);
	if (st.dropped !== undefined) bits.push(`drop ${st.dropped}`);
	if (st.latencyMs !== undefined) bits.push(`lat ${st.latencyMs}ms`);
	if (st.rssMB !== undefined) bits.push(`${st.rssMB}MB`);
	return bits.join(' · ');
}

function planeCell(worker, playerStats) {
	if (!worker) return '<span class="st unknown">no supervisor</span>';
	const st = worker.state || 'unknown';
	let html = `<span class="st ${st}">${st}</span>`;
	// worker-reported truth (Session 8): the meter dying alongside this chip is the proof
	if (worker.muted) html += ' <span class="mutedchip">MUTED</span>';
	if (worker.pid) html += ` <span class="mono">pid ${worker.pid}</span>`;
	if (worker.restarts) html += ` <span class="mono">restarts ${worker.restarts}</span>`;
	const stats = playerStats || worker.lastStats;
	// tally chip (Session 8 Part C): downstream program/preview from the sender's
	// stats poll — program strong, preview subtle (the row tints to match)
	const tly = stats && stats.tally;
	if (tly && tly.program) html += ' <span class="tallychip pgm">PGM</span>';
	else if (tly && tly.preview) html += ' <span class="tallychip pvw">PVW</span>';
	if (stats) html += `<br><span class="mono">${fmtStats(stats)}</span>`;
	if (playerStats && playerStats.lastEv && playerStats.lastEv !== 'loaded') {
		html += `<br><span class="mono">(${playerStats.lastEv})</span>`;
	}
	return html;
}

function btns(player, plane) {
	return `<span class="planebtns">
		<button data-cmd="reload ${player} ${plane}">reload</button>
		<button data-cmd="stop ${player} ${plane}">stop</button>
		<button data-cmd="start ${player} ${plane}">start</button>
	</span>`;
}

let rowsKey = ''; // structure fingerprint: rebuild rows only when it changes,
// otherwise update stat spans in place — a full innerHTML swap every tick
// swallows operator clicks on buttons being replaced mid-click.

// ---- previews + meters (Session 7): targeted updates ONLY ------------------
// Canvas repaints and meter updates never rebuild row DOM; rows still rebuild
// only when the player set changes (canvases/meters attach at rebuild).

const prevLastFrame = {};   // player -> ms of last painted frame
let scratchCv = null;       // shared offscreen canvas for proxy-res -> row-res scaling

let paintErrShown = false;
function paintPreview(f) {
	try { paintPreviewInner(f); } catch (err) {
		if (!paintErrShown) { paintErrShown = true; setMsg(`preview paint failed (${f.player}): ${err.message}`); }
	}
}

function paintPreviewInner(f) {
	const cv = $(`pcv-${f.player}`);
	if (!cv) return;
	if (!scratchCv) scratchCv = document.createElement('canvas');
	if (scratchCv.width !== f.xres || scratchCv.height !== f.yres) {
		scratchCv.width = f.xres; scratchCv.height = f.yres;
	}
	let bytes = f.data; // Uint8Array (RGBA — requested directly from NDI)
	if (f.stride !== f.xres * 4) { // compact rows if the proxy ever pads strides
		bytes = new Uint8Array(f.xres * f.yres * 4);
		for (let y = 0; y < f.yres; y++)
			bytes.set(f.data.subarray(y * f.stride, y * f.stride + f.xres * 4), y * f.xres * 4);
	}
	const img = new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, f.xres * f.yres * 4), f.xres, f.yres);
	scratchCv.getContext('2d').putImageData(img, 0, 0);
	const ctx = cv.getContext('2d');
	ctx.drawImage(scratchCv, 0, 0, cv.width, cv.height);
	prevLastFrame[f.player] = Date.now();
	cv.classList.remove('stale');
}

// Badge: a parked/stopped player's sender stays advertised with a frozen last
// frame until host restart (Session 6) — mark the row so a live-looking
// thumbnail isn't mistaken for a live stream. Existing status data only.
function videoBadgeText(name, host, workers, status) {
	if (!status) return 'no status';
	const w = host || workers.get(`${name}/video`);
	if (!w) return 'no worker';
	if (w.state !== 'running') return w.state;
	if (host) {
		const ps = host.playerStats && host.playerStats[name];
		const ev = ps && ps.lastEv;
		if (ev === 'stopped') return 'stopped';
		if (ev === 'window-failed') return 'failed';
		if (ev === 'window-gone') return 'rebuilding';
		if (ev === 'exiting') return 'parked';
	}
	return '';
}

const meterShown = {};      // player -> displayed level (for decay)
const meterLastSeen = {};   // device fragment -> ms of last helper line
let meterData = {};         // device fragment -> {channels, peaks}

function meterTargets() {
	// player -> {device fragment, channelOffset|null} from current config
	const out = {};
	if (!lastState || !lastState.config) return out;
	const defs = (lastState.config.defaults && lastState.config.defaults.audio) || {};
	for (const s of lastState.config.sources) {
		const a = s.audio || {};
		out[s.name] = {
			device: a.audioOutputDevice || defs.audioOutputDevice || '',
			offset: a.channelOffset !== undefined ? a.channelOffset : null,
		};
	}
	return out;
}

function updateMeters() {
	const targets = meterTargets();
	const now = Date.now();
	for (const [player, t] of Object.entries(targets)) {
		const fill = $(`mfill-${player}`);
		const wrap = $(`meter-${player}`);
		if (!fill || !wrap) continue;
		const d = meterData[t.device];
		const fresh = d && now - (meterLastSeen[t.device] || 0) < 2500;
		if (!fresh) { wrap.classList.add('dead'); continue; } // helper down: grey, rows keep working
		wrap.classList.remove('dead');
		let peak = 0;
		if (t.offset !== null) peak = d.peaks[t.offset] || 0;
		else peak = Math.max(d.peaks[0] || 0, d.peaks[1] || 0); // no offset = stereo ch1/2
		const prev = meterShown[player] || 0;
		const shown = Math.max(peak, prev * 0.6); // short decay
		meterShown[player] = shown;
		fill.style.width = `${Math.min(100, Math.round(shown * 100))}%`;
		fill.classList.toggle('hot', peak > 0.02);
	}
}

// ---- Audio Manager grid (Session 8 Part A, KICKOFF Phase 4 core) ------------
// Mutable UX on immutable infrastructure: the grid is a sources.json editor with
// a Connect button. Rows = channels 1-8 of each distinct endpoint; cells show the
// assignment + the LIVE per-channel meter (same meter-update stream as the rows).
// Click a player chip, then a channel, to STAGE a move; Connect saves the config
// and issues `reload <player> audio` — the exact Session 5 channelOffset path.
// Conflicts (occupied channel) are rejected inline before anything is staged.

let amSelected = null;        // player chip awaiting a channel click
const amStaged = new Map();   // player -> { device, offset } staged, unsaved
let amGridKey = '';           // structure fingerprint (targeted-update discipline)
let amDeviceList = [];        // device order for meter fill ids

function setAmMsg(text) { $('ammsg').textContent = text || ''; }

function amAssignments() {
	// current config truth: device -> [8 channel slots], plus unassigned players
	const targets = meterTargets();
	const devices = new Map();
	const unassigned = [];
	for (const [player, t] of Object.entries(targets)) {
		if (!t.device) { unassigned.push(player); continue; }
		if (!devices.has(t.device)) devices.set(t.device, new Array(8).fill(null));
		if (t.offset !== null) devices.get(t.device)[t.offset] = player;
		else unassigned.push(player);
	}
	return { devices, unassigned };
}

function amStagedView() {
	// assignments with staged moves applied — what the grid displays
	const view = amAssignments();
	for (const [player, mv] of amStaged) {
		for (const arr of view.devices.values()) {
			const i = arr.indexOf(player);
			if (i >= 0) arr[i] = null;
		}
		const un = view.unassigned.indexOf(player);
		if (un >= 0) view.unassigned.splice(un, 1);
		if (!view.devices.has(mv.device)) view.devices.set(mv.device, new Array(8).fill(null));
		view.devices.get(mv.device)[mv.offset] = player;
	}
	return view;
}

function amChip(player) {
	const cls = ['amchip'];
	if (amSelected === player) cls.push('selected');
	if (amStaged.has(player)) cls.push('staged');
	return `<button class="${cls.join(' ')}" data-amplayer="${player}">${player}</button>`;
}

function renderGrid() {
	if (!lastState || !lastState.config || !$('amgrid')) return;
	const view = amStagedView();
	const devices = [...view.devices.keys()].sort();
	const key = JSON.stringify([devices.map(dv => view.devices.get(dv)), view.unassigned, amSelected, [...amStaged]]);
	if (key !== amGridKey) {
		amGridKey = key;
		amDeviceList = devices;
		let html = '';
		devices.forEach((dev, d) => {
			const slots = view.devices.get(dev);
			html += `<div class="amdev"><div class="amdevname mono">${dev}</div><table class="amtbl">`;
			for (let ch = 0; ch < 8; ch++) {
				const p = slots[ch];
				html += `<tr>
					<td class="mono amch">ch${ch + 1}</td>
					<td class="ammeter"><div class="meter"><div class="meterfill" id="amfill-${d}-${ch}"></div></div></td>
					<td class="amcell" data-amch="${ch}" data-amdev="${dev}">${p ? amChip(p) : '<span class="amempty">—</span>'}</td>
				</tr>`;
			}
			html += '</table></div>';
		});
		const pool = view.unassigned.map(amChip).join(' ') || '<span class="amempty">(none)</span>';
		html += `<div class="ampool">Unassigned: ${pool}</div>`;
		if (amStaged.size) {
			const list = [...amStaged].map(([p, mv]) => `${p} → ch${mv.offset + 1}`).join(', ');
			html += `<div class="amstagedlist">staged: ${list}</div>`;
		}
		$('amgrid').innerHTML = html;
	}
	$('btnConnect').disabled = !amStaged.size;
	$('btnConnect').textContent = amStaged.size ? `Connect (${amStaged.size})` : 'Connect';
	$('btnDiscard').disabled = !amStaged.size && !amSelected;
	updateGridMeters();
}

function updateGridMeters() {
	const now = Date.now();
	amDeviceList.forEach((dev, d) => {
		const data = meterData[dev];
		const fresh = data && now - (meterLastSeen[dev] || 0) < 2500;
		for (let ch = 0; ch < 8; ch++) {
			const fill = $(`amfill-${d}-${ch}`);
			if (!fill) continue;
			const wrap = fill.parentElement;
			if (!fresh) { wrap.classList.add('dead'); continue; }
			wrap.classList.remove('dead');
			const peak = (data.peaks && data.peaks[ch]) || 0;
			fill.style.width = `${Math.min(100, Math.round(peak * 100))}%`;
			fill.classList.toggle('hot', peak > 0.02);
		}
	});
}

function amCellClick(cell) {
	const ch = parseInt(cell.dataset.amch, 10);
	const dev = cell.dataset.amdev;
	if (!amSelected) return setAmMsg('click a player chip first, then a channel');
	const view = amStagedView();
	const occupant = view.devices.get(dev) ? view.devices.get(dev)[ch] : null;
	if (occupant && occupant !== amSelected) {
		return setAmMsg(`ch${ch + 1} is ${occupant}'s — move ${occupant} first`);
	}
	const t = meterTargets()[amSelected];
	if (t && t.device === dev && t.offset === ch) amStaged.delete(amSelected); // back to current spot = unstage
	else amStaged.set(amSelected, { device: dev, offset: ch });
	amSelected = null;
	setAmMsg('');
	renderGrid();
}

async function amConnect() {
	if (!amStaged.size || !lastState || !lastState.config) return;
	const config = JSON.parse(JSON.stringify(lastState.config));
	const defDev = (config.defaults && config.defaults.audio && config.defaults.audio.audioOutputDevice) || '';
	const moved = [];
	for (const [player, mv] of amStaged) {
		const src = config.sources.find(s => s.name === player);
		if (!src) continue;
		src.audio = src.audio || {};
		src.audio.channelOffset = mv.offset;
		// pin the device only when it differs from what the player already resolves to
		if (mv.device !== (src.audio.audioOutputDevice || defDev)) src.audio.audioOutputDevice = mv.device;
		moved.push(player);
	}
	const res = await window.cc.saveConfig(config);
	if (!res.ok) return setAmMsg('rejected: ' + res.errors.join('; ')); // validateConfig conflicts surface here
	for (const p of moved) await window.cc.command(`reload ${p} audio`);
	amStaged.clear();
	amSelected = null;
	setAmMsg(`connected: ${moved.join(', ')} — audio plane rebuilding (~3–7 s, siblings untouched)`);
	tick();
}

function render(state) {
	lastState = state;
	$('cfgPath').textContent = state.configPath;
	const up = !!(state.supervisorPid && state.status);
	$('supPill').textContent = up
		? `supervisor: running pid ${state.supervisorPid} (${state.status.videoTopology})`
		: state.supervisorPid ? `supervisor: pid ${state.supervisorPid} (no status yet)` : 'supervisor: stopped';
	$('supPill').className = `pill ${up ? 'up' : 'down'}`;
	$('btnStart').disabled = !!state.supervisorPid;
	$('btnStopAll').disabled = !state.supervisorPid;
	$('btnRescan').disabled = !state.supervisorPid;
	$('raw').textContent = state.status ? JSON.stringify(state.status, null, 2) : '(no status)';

	if (state.configErrors && state.configErrors.length && state.config) {
		setMsg('sources.json problems: ' + state.configErrors.join('; '));
	}

	const prev = state.previews || { available: false, global: false, rowOff: [], states: {} };
	$('btnPrevAll').textContent = `Previews: ${prev.global ? 'ON' : 'OFF'}`;
	$('btnPrevAll').disabled = !prev.available;
	if (!prev.available && prev.reason) $('btnPrevAll').title = prev.reason;

	const sources = state.config ? state.config.sources : [];
	const key = sources.map(s => s.name).join('|');
	if (key !== rowsKey) {
		rowsKey = key;
		$('rows').innerHTML = sources.map(source => `<tr id="row-${source.name}">
			<td><b>${source.name}</b></td>
			<td class="mono" id="sid-${source.name}"></td>
			<td class="mono" id="ndi-${source.name}"></td>
			<td><div class="prevrow">
				<div class="prevwrap"><canvas id="pcv-${source.name}" width="160" height="90"></canvas><span class="pbadge" id="pbadge-${source.name}" hidden></span></div>
				<div><span id="vcell-${source.name}"></span><br>${btns(source.name, 'video')}
					<button data-prevtoggle="${source.name}" id="ptog-${source.name}">preview</button>
					<button data-popout="${source.name}" id="pop-${source.name}">pop out</button></div>
			</div></td>
			<td><div class="meterwrap"><div class="meter" id="meter-${source.name}"><div class="meterfill" id="mfill-${source.name}"></div></div><span class="mono mch" id="mch-${source.name}"></span></div>
				<span id="acell-${source.name}"></span><br>${btns(source.name, 'audio')}
				<button data-mute="${source.name}" id="mute-${source.name}">mute</button>
				<button data-solo="${source.name}" id="solo-${source.name}">solo</button></td>
			<td><button data-edit="${source.name}">Edit</button> <button data-remove="${source.name}">Remove</button></td>
		</tr>`).join('');
	}
	const workers = new Map((state.status ? state.status.workers : []).map(w => [w.key, w]));
	const host = workers.get('videohost/video');
	const meterMap = meterTargets();
	for (const source of sources) {
		const name = source.name;
		$(`sid-${name}`).textContent = source.streamId || '';
		$(`ndi-${name}`).textContent = state.ndiNames && state.ndiNames[name] ? state.ndiNames[name] : '';
		const videoWorker = host || workers.get(`${name}/video`);
		const playerStats = host && host.playerStats ? host.playerStats[name] : null;
		$(`vcell-${name}`).innerHTML = planeCell(videoWorker, playerStats);
		$(`acell-${name}`).innerHTML = planeCell(workers.get(`${name}/audio`));

		// preview chrome (targeted updates on existing row DOM)
		const rowOn = prev.global && prev.available && !prev.rowOff.includes(name);
		const tog = $(`ptog-${name}`);
		tog.textContent = `preview: ${prev.rowOff.includes(name) ? 'off' : 'on'}`;
		tog.disabled = !prev.available;
		const cv = $(`pcv-${name}`);
		const badge = $(`pbadge-${name}`);
		const badgeText = rowOn ? videoBadgeText(name, host, workers, state.status) : (prev.available ? 'preview off' : '');
		badge.textContent = badgeText;
		badge.hidden = !badgeText;
		cv.classList.toggle('off', !rowOn);
		if (rowOn && Date.now() - (prevLastFrame[name] || 0) > 4000) cv.classList.add('stale');

		// tally row tint (program strong, preview subtle) + pop-out button state
		const tly = playerStats && playerStats.tally;
		const tr = $(`row-${name}`);
		tr.classList.toggle('pgm', !!(tly && tly.program));
		tr.classList.toggle('pvw', !!(tly && !tly.program && tly.preview));
		const pop = $(`pop-${name}`);
		pop.classList.toggle('active', !!(state.popouts && state.popouts.includes(name)));

		// meter channel label
		const t = meterMap[name];
		$(`mch-${name}`).textContent = t && t.offset !== null ? `ch${t.offset + 1}` : 'ch1/2';

		// mute/solo buttons reflect INTENT (console state); the MUTED chip + dead
		// meter reflect worker-reported truth — they converge via muteSync
		const mix = state.audioMix || { solo: null, muted: [] };
		const mtog = $(`mute-${name}`);
		mtog.textContent = mix.muted.includes(name) ? 'unmute' : 'mute';
		mtog.classList.toggle('active', mix.muted.includes(name));
		const stog = $(`solo-${name}`);
		stog.classList.toggle('active', mix.solo === name);
	}
	updateMeters();
	renderGrid();
}

async function tick() {
	try {
		const state = await window.cc.state();
		// resolve NDI names for display (prefix fallback happens in url-builder)
		state.ndiNames = {};
		if (state.config) {
			for (const s of state.config.sources) {
				const u = await window.cc.urls(s, state.config.defaults);
				state.ndiNames[s.name] = u.ndiName || '';
			}
		}
		render(state);
	} catch (err) { setMsg(String(err)); }
}

// ---- editor ---------------------------------------------------------------

// Device dropdown (Session 9): real render endpoints with channel counts, so the
// operator can SEE which endpoint is the 8-channel one instead of guessing what a
// free-text field expects. Values are full endpoint labels — vdo.ninja matches by
// normalized label substring, so a full label always matches its own endpoint.
async function populateDeviceSelect(current) {
	const sel = $('f_adev');
	const defs = (lastState && lastState.config && lastState.config.defaults) || {};
	const defDev = (defs.audio && defs.audio.audioOutputDevice) || '';
	sel.innerHTML = `<option value="">${defDev ? `(default: ${defDev})` : '(config has no default device)'}</option>`;
	if (current) { // keep the configured value selectable before enumeration lands
		sel.innerHTML += `<option value="${current.replace(/"/g, '&quot;')}">${current} (configured)</option>`;
		sel.value = current;
	}
	const res = await window.cc.audioDevices();
	if (res.error) { setMsg(`device list unavailable: ${res.error}`); return; }
	const opts = [{ v: '', t: defDev ? `(default: ${defDev})` : '(config has no default device)' }];
	let seen = false;
	for (const d of res.devices) {
		if (d.label === current) seen = true;
		const mark = d.label === res.default ? ' — system default' : '';
		opts.push({ v: d.label, t: `${d.label} — ${d.channels} ch${mark}` });
	}
	if (current && !seen) opts.push({ v: current, t: `${current} (configured, not currently present)` });
	sel.innerHTML = opts.map(o => `<option value="${o.v.replace(/"/g, '&quot;')}">${o.t}</option>`).join('');
	sel.value = current || '';
}

function openEditor(name) {
	editing = name;
	$('edTitle').textContent = name ? `Edit player: ${name}` : 'Add player';
	const src = name && lastState && lastState.config
		? lastState.config.sources.find(s => s.name === name) : null;
	const v = (src && src.video) || {};
	const a = (src && src.audio) || {};
	$('f_name').value = src ? src.name : '';
	$('f_streamId').value = src ? src.streamId || '' : '';
	$('f_room').value = src ? src.room || '' : '';
	$('f_ndiName').value = v.ndiName || '';
	$('f_width').value = v.width !== undefined ? v.width : '';
	$('f_height').value = v.height !== undefined ? v.height : '';
	$('f_fps').value = v.fps !== undefined ? v.fps : '';
	$('f_vextra').value = v.extraParams || '';
	populateDeviceSelect(a.audioOutputDevice || '');
	$('f_choff').value = a.channelOffset !== undefined ? a.channelOffset : '';
	$('f_channels').value = a.channels !== undefined ? a.channels : '';
	$('f_aextra').value = a.extraParams || '';
	$('editor').hidden = false;
	previewUrls();
}

function numOrOmit(val) {
	return val === '' ? undefined : Number(val);
}

function formSource() {
	const source = {
		name: $('f_name').value.trim(),
		streamId: $('f_streamId').value.trim(),
	};
	const room = $('f_room').value.trim();
	if (room) source.room = room;
	const video = {};
	if ($('f_ndiName').value.trim()) video.ndiName = $('f_ndiName').value.trim();
	for (const [field, id] of [['width', 'f_width'], ['height', 'f_height'], ['fps', 'f_fps']]) {
		const n = numOrOmit($(id).value);
		if (n !== undefined) video[field] = n;
	}
	if ($('f_vextra').value.trim()) video.extraParams = $('f_vextra').value.trim();
	if (Object.keys(video).length) source.video = video;
	const audio = {};
	if ($('f_adev').value.trim()) audio.audioOutputDevice = $('f_adev').value.trim();
	const choff = numOrOmit($('f_choff').value);
	if (choff !== undefined) audio.channelOffset = choff;
	const channels = numOrOmit($('f_channels').value);
	if (channels !== undefined) audio.channels = channels;
	if ($('f_aextra').value.trim()) audio.extraParams = $('f_aextra').value.trim();
	if (Object.keys(audio).length) source.audio = audio;
	return source;
}

async function previewUrls() {
	if (!lastState || !lastState.config) return;
	const u = await window.cc.urls(formSource(), lastState.config.defaults);
	$('u_video').textContent = u.error || u.video;
	$('u_audio').textContent = u.error || u.audio;
	$('u_ndi').textContent = u.error || u.ndiName;
}

async function saveEditor() {
	if (!lastState || !lastState.config) return;
	const source = formSource();
	if (!source.name || !source.streamId) return setMsg('name and streamId are required');
	const config = JSON.parse(JSON.stringify(lastState.config));
	const idx = config.sources.findIndex(s => s.name === (editing || source.name));
	if (editing && idx >= 0) config.sources[idx] = source;
	else if (idx >= 0) return setMsg(`a player named ${source.name} already exists`);
	else config.sources.push(source);
	const res = await window.cc.saveConfig(config);
	if (!res.ok) return setMsg('not saved: ' + res.errors.join('; '));
	setMsg(editing
		? `Saved. Apply with the ${source.name} reload buttons (video/audio as changed).`
		: 'Saved. Rescan to bring the new player up.');
	$('editor').hidden = true;
	editing = null;
	tick();
}

async function removePlayer(name) {
	if (!lastState || !lastState.config) return;
	if (!confirm(`Remove ${name} from sources.json?${lastState.supervisorPid ? ' Their workers will be stopped by the rescan.' : ''}`)) return;
	const config = JSON.parse(JSON.stringify(lastState.config));
	config.sources = config.sources.filter(s => s.name !== name);
	const res = await window.cc.saveConfig(config);
	if (!res.ok) return setMsg('not saved: ' + res.errors.join('; '));
	if (lastState.supervisorPid) await window.cc.command('rescan');
	setMsg(`Removed ${name}${lastState.supervisorPid ? ' — rescan issued' : ''}.`);
	tick();
}

// ---- wiring ---------------------------------------------------------------

document.body.addEventListener('click', async e => {
	const cmd = e.target.dataset && e.target.dataset.cmd;
	if (cmd) {
		const res = await window.cc.command(cmd);
		setMsg(res.ok ? `sent: ${cmd}` : `command failed: ${res.error}`);
		return;
	}
	if (e.target.dataset && e.target.dataset.edit) return openEditor(e.target.dataset.edit);
	if (e.target.dataset && e.target.dataset.remove) return removePlayer(e.target.dataset.remove);
	if (e.target.dataset && e.target.dataset.prevtoggle) {
		const name = e.target.dataset.prevtoggle;
		const isOff = lastState && lastState.previews && lastState.previews.rowOff.includes(name);
		await window.cc.previewToggle(name, isOff); // off -> on, on -> off
		return tick();
	}
	if (e.target.dataset && e.target.dataset.mute) {
		const name = e.target.dataset.mute;
		const on = !(lastState && lastState.audioMix && lastState.audioMix.muted.includes(name));
		await window.cc.audioMute(name, on);
		return tick();
	}
	if (e.target.dataset && e.target.dataset.solo) {
		const name = e.target.dataset.solo;
		const cur = lastState && lastState.audioMix ? lastState.audioMix.solo : null;
		await window.cc.audioSolo(cur === name ? null : name); // re-click clears solo
		return tick();
	}
	if (e.target.dataset && e.target.dataset.popout) {
		await window.cc.popoutToggle(e.target.dataset.popout);
		return tick();
	}
	// Audio Manager grid: chip click selects (chips sit inside cells — check first)
	if (e.target.dataset && e.target.dataset.amplayer) {
		amSelected = amSelected === e.target.dataset.amplayer ? null : e.target.dataset.amplayer;
		setAmMsg(amSelected ? `now click a channel for ${amSelected}` : '');
		return renderGrid();
	}
	const amCell = e.target.closest ? e.target.closest('[data-amch]') : null;
	if (amCell) return amCellClick(amCell);
});

$('btnPrevAll').addEventListener('click', async () => {
	const on = !(lastState && lastState.previews && lastState.previews.global);
	await window.cc.previewToggle('global', on);
	tick();
});

window.cc.onPreviewFrame(paintPreview);
window.cc.onMeterUpdate(update => {
	meterData[update.device] = update;
	meterLastSeen[update.device] = Date.now();
	updateMeters();
	updateGridMeters();
});

$('btnConnect').addEventListener('click', amConnect);
$('btnDiscard').addEventListener('click', () => {
	amStaged.clear();
	amSelected = null;
	setAmMsg('');
	renderGrid();
});

$('btnStart').addEventListener('click', async () => {
	const res = await window.cc.startSupervisor();
	setMsg(res.ok ? (res.adopted ? 'Adopted running supervisor.' : `Supervisor started (pid ${res.pid}).`) : `Start failed: ${res.error}`);
	tick();
});
$('btnStopAll').addEventListener('click', async () => {
	if (!confirm('Stop the supervisor and every worker?')) return;
	const res = await window.cc.command('quit');
	setMsg(res.ok ? 'Quit sent — workers stopping.' : `Failed: ${res.error}`);
});
$('btnRescan').addEventListener('click', async () => {
	const res = await window.cc.command('rescan');
	setMsg(res.ok ? 'Rescan sent.' : `Failed: ${res.error}`);
});
$('btnAdd').addEventListener('click', () => openEditor(''));
$('btnSave').addEventListener('click', saveEditor);
$('btnCancel').addEventListener('click', () => { $('editor').hidden = true; editing = null; });
for (const el of document.querySelectorAll('#editor input, #editor select')) el.addEventListener('input', previewUrls);

tick();
setInterval(tick, 2000);
