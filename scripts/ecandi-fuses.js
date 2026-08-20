// ECANDI afterPack fuse hook — Session 11 (fork; replaces afterPackHook.js for
// ECANDI builds only, wired in electron-builder.ecandi.js).
//
// Upstream's setFuses.js flips RunAsNode OFF as hardening. ECANDI's process
// topology REQUIRES run-as-node: the console spawns supervisor.js as the same
// ECANDI.exe under ELECTRON_RUN_AS_NODE (SESSION11-SPEC §2, the established
// console→supervisor pattern). So this hook keeps upstream's fuse set verbatim
// EXCEPT RunAsNode stays enabled — a deliberate, ledgered deviation. NODE_OPTIONS
// injection and --inspect stay disabled: the spawn sets one env var on a known
// binary, none of the disabled vectors are needed.
'use strict';

const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const path = require('path');
const fs = require('fs');

exports.default = async function (context) {
	const { appOutDir, packager, electronPlatformName } = context;
	const { productFilename } = packager.appInfo;
	if (electronPlatformName !== 'win32') {
		throw new Error(`ECANDI v1 is Windows-only; unexpected platform ${electronPlatformName}`);
	}
	const electronBinaryPath = path.join(appOutDir, `${productFilename}.exe`);
	if (!fs.existsSync(electronBinaryPath)) {
		const contents = fs.existsSync(appOutDir) ? fs.readdirSync(appOutDir) : [];
		throw new Error(`Electron binary not found at: ${electronBinaryPath}. appOutDir contains: ${contents.join(', ')}`);
	}

	console.log('[ecandi-fuses] setting fuses (RunAsNode stays ENABLED — supervisor self-spawn needs it)');
	// Fuse failures are security failures and must stop the package build.
	await flipFuses(electronBinaryPath, {
		version: FuseVersion.V1,
		// THE deviation from upstream: the console→supervisor spawn pattern.
		[FuseV1Options.RunAsNode]: true,
		// Everything below matches upstream setFuses.js exactly.
		[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
		[FuseV1Options.EnableNodeCliInspectArguments]: false,
		[FuseV1Options.EnableCookieEncryption]: true,
		[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
		[FuseV1Options.OnlyLoadAppFromAsar]: false,
		[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
		[FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
	});
	console.log('[ecandi-fuses] fuses set');
};
