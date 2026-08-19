// Session 8 Part C verify-early — does NDI-native tally work against a real consumer?
// (SESSION8-SPEC §3: NDI-native first; Studio Monitor raises program tally.)
// Grandiose sender emitting an animated pattern, polling sender.tally() at 500 ms and
// logging every change. Attach/detach a tally-capable consumer (NDI Studio Monitor)
// and watch on_program flip. Pure Node — no live-host wedge class.
//   node capture/test/tally-scratch.js [--name=CC-S8-TALLY] [--seconds=120]
'use strict';
const grandiose = require('@stagetimerio/grandiose');

function arg(name, dflt) {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : dflt;
}
const NAME = arg('name', 'CC-S8-TALLY');
const SECONDS = parseInt(arg('seconds', '120'), 10);
const W = 1280, H = 720, FPS = 30;

function ts() { return new Date().toISOString().slice(11, 23); }

async function main() {
	const sender = await grandiose.send({ name: NAME, clockVideo: true });
	console.log(`${ts()} [tally] ${NAME} up (${W}x${H}@${FPS}, ${SECONDS}s) — attach Studio Monitor now`);
	const frame = Buffer.alloc(W * H * 4);
	let last = { on_program: null, on_preview: null };
	const poll = setInterval(() => {
		const t = sender.tally();
		if (t.on_program !== last.on_program || t.on_preview !== last.on_preview) {
			console.log(`${ts()} [tally] CHANGE program=${t.on_program} preview=${t.on_preview} (changed=${t.changed}) connections=${sender.connections()}`);
			last = { on_program: t.on_program, on_preview: t.on_preview };
		}
	}, 500);
	let n = 0;
	const t0 = Date.now();
	while (Date.now() - t0 < SECONDS * 1000) {
		const barY = Math.floor((n % FPS) * (H - 40) / FPS);
		for (let y = barY; y < barY + 40 && y < H; y++) frame.fill(255, y * W * 4, y * W * 4 + W * 4);
		await sender.video({
			xres: W, yres: H, frameRateN: FPS, frameRateD: 1,
			fourCC: grandiose.FOURCC_BGRA, pictureAspectRatio: W / H,
			frameFormatType: grandiose.FORMAT_TYPE_PROGRESSIVE,
			lineStrideBytes: W * 4, data: frame,
		});
		frame.fill(0, barY * W * 4, Math.min(barY + 40, H) * W * 4);
		n++;
	}
	clearInterval(poll);
	console.log(`${ts()} [tally] done: ${n} frames, final tally program=${last.on_program} preview=${last.on_preview}`);
	await sender.destroy();
	process.exit(0);
}

main().catch(err => { console.error('[tally] FAILED:', err); process.exit(1); });
