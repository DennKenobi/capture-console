// NDI sender utility process — Capture Console fork, Session 5 Part B.
// Runs under Electron utilityProcess with its OWN event loop: send submissions and
// completion callbacks never touch the busy video-host main loop (whose starvation
// produced 50-300 ms completion latencies and paint-delivery sag; pure-Node-like
// loops complete 6x1080p30 with zero drops at depth 2).
//
// Protocol (parentPort messages):
//   in : {type:'create', player, name, fps, depth}
//        {type:'frame', player, w, h, stride, data:Uint8Array}   (copy-on-serialize)
//        {type:'destroy', player} | {type:'shutdown'}
//   out: {type:'ready', player, ndiName}
//        {type:'create-failed', player, error}
//        {type:'stats', players:{[player]:{sent,dropped,latencyMs,inFlight}}}
//        {type:'log', line}
'use strict';

const ndi = require('./ndi-sender');

const senders = new Map(); // player -> { sender, name }

function post(msg) { try { process.parentPort.postMessage(msg); } catch {} }
function log(line) { post({ type: 'log', line: `[ndi-proc] ${line}` }); }

process.parentPort.on('message', async (e) => {
	const m = e.data;
	if (m.type === 'create') {
		if (senders.has(m.player)) { post({ type: 'ready', player: m.player, ndiName: senders.get(m.player).name }); return; }
		try {
			const sender = await ndi.create(m.name, { fps: m.fps, depth: m.depth, onLog: log });
			senders.set(m.player, { sender, name: m.name });
			post({ type: 'ready', player: m.player, ndiName: m.name });
		} catch (err) {
			post({ type: 'create-failed', player: m.player, error: String(err && err.message || err) });
		}
		return;
	}
	if (m.type === 'frame') {
		const rec = senders.get(m.player);
		if (!rec) return;
		const d = m.data;
		rec.sender.sendFrame(Buffer.from(d.buffer, d.byteOffset, d.byteLength), m.w, m.h, m.stride);
		return;
	}
	if (m.type === 'destroy') {
		const rec = senders.get(m.player);
		if (!rec) return;
		senders.delete(m.player);
		const drained = await rec.sender.drain(500);
		if (drained) { try { await rec.sender.destroy(); } catch {} }
		else log(`${m.player} sender not drained — skipping destroy`);
		return;
	}
	if (m.type === 'shutdown') {
		for (const [player, rec] of senders) {
			const drained = await rec.sender.drain(300);
			if (drained) { try { await rec.sender.destroy(); } catch {} }
			else log(`${player} sender not drained — skipping destroy`);
		}
		senders.clear();
		process.exit(0);
	}
});

setInterval(() => {
	const players = {};
	for (const [player, rec] of senders) players[player] = rec.sender.stats();
	if (Object.keys(players).length) post({ type: 'stats', players });
}, 5000);
