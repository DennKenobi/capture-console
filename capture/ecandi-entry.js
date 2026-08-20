// ECANDI packaged entry — Session 11 (SESSION11-SPEC §2, packaged process topology).
// A packaged app is ONE exe playing many roles: packaged Electron always boots the
// asar's package.json "main" and ignores script-path arguments, so the dev pattern
// "electron ./capture/video-host.js" cannot spawn workers from ECANDI.exe. Instead
// the supervisor passes --ecandi-role=<role> and this entry dispatches. The dev tree
// is untouched: this file becomes "main" only in the packaged build, via
// extraMetadata in electron-builder.ecandi.js.
//
//   ECANDI.exe                        → management console (the operator app)
//   ECANDI.exe --ecandi-role=vhost    → consolidated video host
//   ECANDI.exe --ecandi-role=audio    → audio worker
//   ECANDI.exe --ecandi-role=slice    → per-player video worker (per-player topology)
//
// (The supervisor itself is not a role here — it runs as plain Node under
// ELECTRON_RUN_AS_NODE with an explicit script path, same as in the dev tree.)
'use strict';

const hit = process.argv.find(a => a.startsWith('--ecandi-role='));
const role = hit ? hit.split('=').slice(1).join('=') : 'console';

const ENTRIES = {
	console: './console-main.js',
	vhost: './video-host.js',
	audio: './audio-main.js',
	slice: './slice-main.js',
};

if (!ENTRIES[role]) {
	console.error(`[ecandi-entry] unknown --ecandi-role="${role}" (know: ${Object.keys(ENTRIES).join(', ')})`);
	process.exit(2);
}
require(ENTRIES[role]);
