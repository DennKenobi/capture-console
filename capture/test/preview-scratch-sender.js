// Scratch NDI sender for the Session 7 preview verify-early chain — pure Node.
// Animated BGRA pattern at a real cadence, prints connections() + own CPU every
// second so a receiver's connect/disconnect (and its encode cost) is visible
// from the sender side.
//   node capture/test/preview-scratch-sender.js [--name=CC-S7-SCRATCH] [--fps=30]
//     [--width=1920] [--height=1080] [--seconds=120]
'use strict';
const grandiose = require('@stagetimerio/grandiose');

function arg(name, dflt) {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : dflt;
}
const NAME = arg('name', 'CC-S7-SCRATCH');
const FPS = parseInt(arg('fps', '30'), 10);
const W = parseInt(arg('width', '1920'), 10);
const H = parseInt(arg('height', '1080'), 10);
const SECONDS = parseInt(arg('seconds', '120'), 10);

async function main() {
	const sender = await grandiose.send({ name: NAME, clockVideo: true });
	console.log(`[sender] ${NAME} up: ${W}x${H}@${FPS}, ${SECONDS}s`);
	const frame = Buffer.alloc(W * H * 4);
	// static gradient base; a moving bar is redrawn per frame
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			frame[i] = (x * 255 / W) | 0; frame[i + 1] = (y * 255 / H) | 0;
			frame[i + 2] = 64; frame[i + 3] = 255;
		}
	let n = 0, lastCpu = process.cpuUsage(), lastT = Date.now();
	const t0 = Date.now();
	const tick = setInterval(() => {
		const now = Date.now(), cpu = process.cpuUsage();
		const cores = ((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / ((now - lastT) * 1000);
		lastCpu = cpu; lastT = now;
		console.log(`[sender] t=${((now - t0) / 1000).toFixed(0)}s connections=${sender.connections()} senderCores=${cores.toFixed(2)} sentFrames=${n}`);
	}, 1000);
	while (Date.now() - t0 < SECONDS * 1000) {
		const barY = Math.floor((n % FPS) * (H - 40) / FPS);
		for (let y = barY; y < barY + 40 && y < H; y++) frame.fill(255, y * W * 4, y * W * 4 + W * 4);
		await sender.video({
			xres: W, yres: H, frameRateN: FPS, frameRateD: 1,
			fourCC: grandiose.FOURCC_BGRA, pictureAspectRatio: W / H,
			frameFormatType: grandiose.FORMAT_TYPE_PROGRESSIVE,
			lineStrideBytes: W * 4, data: frame,
		});
		for (let y = barY; y < barY + 40 && y < H; y++) { // restore gradient rows
			for (let x = 0; x < W; x++) {
				const i = (y * W + x) * 4;
				frame[i] = (x * 255 / W) | 0; frame[i + 1] = (y * 255 / H) | 0;
				frame[i + 2] = 64; frame[i + 3] = 255;
			}
		}
		n++;
	}
	clearInterval(tick);
	console.log(`[sender] done: ${n} frames`);
	await sender.destroy(); // pure Node, no live-host wedge class
	process.exit(0);
}

main().catch(err => { console.error('[sender] FAILED:', err); process.exit(1); });
