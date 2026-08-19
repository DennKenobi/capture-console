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
	if (worker.pid) html += ` <span class="mono">pid ${worker.pid}</span>`;
	if (worker.restarts) html += ` <span class="mono">restarts ${worker.restarts}</span>`;
	const stats = playerStats || worker.lastStats;
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

	const sources = state.config ? state.config.sources : [];
	const key = sources.map(s => s.name).join('|');
	if (key !== rowsKey) {
		rowsKey = key;
		$('rows').innerHTML = sources.map(source => `<tr>
			<td><b>${source.name}</b></td>
			<td class="mono" id="sid-${source.name}"></td>
			<td class="mono" id="ndi-${source.name}"></td>
			<td><span id="vcell-${source.name}"></span><br>${btns(source.name, 'video')}</td>
			<td><span id="acell-${source.name}"></span><br>${btns(source.name, 'audio')}</td>
			<td><button data-edit="${source.name}">Edit</button> <button data-remove="${source.name}">Remove</button></td>
		</tr>`).join('');
	}
	const workers = new Map((state.status ? state.status.workers : []).map(w => [w.key, w]));
	const host = workers.get('videohost/video');
	for (const source of sources) {
		const name = source.name;
		$(`sid-${name}`).textContent = source.streamId || '';
		$(`ndi-${name}`).textContent = state.ndiNames && state.ndiNames[name] ? state.ndiNames[name] : '';
		const videoWorker = host || workers.get(`${name}/video`);
		const playerStats = host && host.playerStats ? host.playerStats[name] : null;
		$(`vcell-${name}`).innerHTML = planeCell(videoWorker, playerStats);
		$(`acell-${name}`).innerHTML = planeCell(workers.get(`${name}/audio`));
	}
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
	$('f_adev').value = a.audioOutputDevice || '';
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
for (const el of document.querySelectorAll('#editor input')) el.addEventListener('input', previewUrls);

tick();
setInterval(tick, 2000);
