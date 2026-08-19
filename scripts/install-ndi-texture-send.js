#!/usr/bin/env node

/**
 * Install/build script for the ndi-texture-send native module (Capture Console fork).
 *
 * The module links the NDI SDK that @stagetimerio/grandiose already fetched at its
 * own install time (node_modules/@stagetimerio/grandiose/ndi) — one SDK download for
 * the whole repo, and no SDK binaries ever committed.
 *
 * Environment variables:
 *   NDI_TEXTURE_SEND_SKIP=1  - Skip building the module
 *
 * Usage:
 *   node scripts/install-ndi-texture-send.js [--force]
 */

const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const MODULE_RELATIVE_PATH = path.join('native-modules', 'ndi-texture-send');
const BINARY_RELATIVE_PATH = path.join(MODULE_RELATIVE_PATH, 'build', 'Release', 'ndi_texture_send.node');
const SDK_RELATIVE_PATH = path.join('node_modules', '@stagetimerio', 'grandiose', 'ndi');

main().catch(error => {
  console.error('[ndi-texture-send] Failed to prepare native module.');
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  if (process.env.NDI_TEXTURE_SEND_SKIP === '1') {
    console.log('[ndi-texture-send] NDI_TEXTURE_SEND_SKIP=1, skipping native module install.');
    return;
  }

  if (process.platform !== 'win32') {
    console.log(`[ndi-texture-send] Skipping native module build on ${process.platform} (Windows only).`);
    return;
  }

  const projectRoot = path.resolve(__dirname, '..');
  const moduleDir = path.join(projectRoot, MODULE_RELATIVE_PATH);

  if (!fs.existsSync(moduleDir)) {
    console.warn(`[ndi-texture-send] ${MODULE_RELATIVE_PATH} not found; skipping build.`);
    return;
  }

  const sdkDir = path.join(projectRoot, SDK_RELATIVE_PATH);
  if (!fs.existsSync(path.join(sdkDir, 'include', 'Processing.NDI.Lib.h'))) {
    throw new Error(
      `NDI SDK not found at ${SDK_RELATIVE_PATH} — run the root npm install first ` +
      '(WINDOW_AUDIO_CAPTURE_SKIP=1 CUSTOM_ELECTRON_WINDOWS_VARIANT=win11 npm install) ' +
      'so @stagetimerio/grandiose fetches it.');
  }

  const binaryPath = path.join(projectRoot, BINARY_RELATIVE_PATH);
  const forceBuild = process.argv.includes('--force');

  if ((await fileExists(binaryPath)) && !forceBuild) {
    console.log(`[ndi-texture-send] Native binary already present at ${path.relative(projectRoot, binaryPath)}.`);
    return;
  }

  console.log(`[ndi-texture-send] Installing dependencies and building native module in ${MODULE_RELATIVE_PATH}...`);
  await runNpmInstall(moduleDir);

  if (!(await fileExists(binaryPath))) {
    throw new Error(`Native binary missing after build: ${path.relative(projectRoot, binaryPath)}`);
  }

  console.log('[ndi-texture-send] Native module ready.');
}

async function fileExists(targetPath) {
  try {
    await fsPromises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runNpmInstall(cwd) {
  const npmCliPath = process.env.npm_execpath;
  const hasLock = fs.existsSync(path.join(cwd, 'package-lock.json'));
  const npmArgs = [hasLock ? 'ci' : 'install'];
  let command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let args = npmArgs;

  if (npmCliPath && fs.existsSync(npmCliPath)) {
    command = process.execPath;
    args = [npmCliPath, ...npmArgs];
  } else if (process.platform === 'win32') {
    command = process.env.ComSpec || 'cmd.exe';
    args = ['/d', '/s', '/c', `npm.cmd ${npmArgs.join(' ')}`];
  }

  await new Promise((resolve, reject) => {
    const install = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
    install.on('close', code => {
      if (code === 0) { resolve(); return; }
      reject(new Error(`npm ${npmArgs.join(' ')} exited with code ${code}`));
    });
    install.on('error', reject);
  });
}
