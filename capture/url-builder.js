// URL builder — Capture Console fork, Phase 1.
// Pure functions: sources.json entries -> vdo.ninja view URLs + NDI names.
// No Electron, no I/O. See capture/sources.schema.md for field semantics.
//
// Audio output selection (verified against vdo.ninja main.js, 2026-08-17):
//   &audiooutput=<value> (aliases outputdevice/od) matches by NORMALIZED LABEL
//   SUBSTRING — both sides pass through replace(/[\W]+/g,"_").toLowerCase().
//   &sink=<deviceId> exists but deviceIds are profile-salted, useless with fresh
//   per-worker data dirs. Config therefore stores label fragments (e.g. "VAIO").

'use strict';

function mergedDefaults(defaults = {}) {
	return {
		room: defaults.room || '',
		vdoBase: defaults.vdoBase || 'https://vdo.ninja/',
		ndiPrefix: defaults.ndiPrefix !== undefined ? defaults.ndiPrefix : 'CC-',
		video: Object.assign({ width: 1920, height: 1080, fps: 30 }, defaults.video || {}),
		audio: Object.assign({ audioOutputDevice: '', channels: 8 }, defaults.audio || {}),
	};
}

function resolveVideo(source, defaults) {
	const d = mergedDefaults(defaults);
	return Object.assign({}, d.video, source.video || {});
}

function resolveAudio(source, defaults) {
	const d = mergedDefaults(defaults);
	return Object.assign({}, d.audio, source.audio || {});
}

function ndiName(source, defaults) {
	const d = mergedDefaults(defaults);
	const v = source.video || {};
	return v.ndiName && v.ndiName.trim() ? v.ndiName.trim() : `${d.ndiPrefix}${source.name}`;
}

function baseUrl(source, defaults) {
	const d = mergedDefaults(defaults);
	const base = d.vdoBase.endsWith('/') ? d.vdoBase : d.vdoBase + '/';
	const room = source.room !== undefined && source.room !== '' ? source.room : d.room;
	let url = `${base}?view=${encodeURIComponent(source.streamId)}`;
	if (room) url += `&room=${encodeURIComponent(room)}`;
	return url;
}

function appendExtra(url, extraParams) {
	if (!extraParams) return url;
	const extra = String(extraParams).replace(/^[?&]+/, '');
	return extra ? `${url}&${extra}` : url;
}

/** Video-plane view URL: video only, never any audio. */
function videoUrl(source, defaults) {
	const v = resolveVideo(source, defaults);
	return appendExtra(baseUrl(source, defaults) + '&noaudio', v.extraParams);
}

/** Audio-plane view URL: audio only, output device + channel baked in (immutable).
 *  &channels=N is REQUIRED for multichannel placement: without it vdo.ninja's
 *  offset graph keeps its default width and discards channels beyond it
 *  (verified against main.js param parsing, 2026-08-18). */
function audioUrl(source, defaults) {
	const a = resolveAudio(source, defaults);
	let url = baseUrl(source, defaults) + '&novideo';
	if (a.audioOutputDevice) url += `&audiooutput=${encodeURIComponent(a.audioOutputDevice)}`;
	if (a.channelOffset !== undefined && a.channelOffset !== null && a.channelOffset !== '') {
		url += `&channels=${parseInt(a.channels, 10) || 8}`;
		url += `&channeloffset=${parseInt(a.channelOffset, 10)}`;
	}
	return appendExtra(url, a.extraParams);
}

function validateConfig(config) {
	const errors = [];
	if (!config || !Array.isArray(config.sources) || config.sources.length === 0) {
		errors.push('config.sources must be a non-empty array');
		return errors;
	}
	const names = new Set(), ndiNames = new Set(), offsets = new Map();
	for (const s of config.sources) {
		const label = s.name || '<unnamed>';
		if (!s.name) errors.push('every source needs a name');
		if (!s.streamId) errors.push(`${label}: streamId is required`);
		if (names.has(s.name)) errors.push(`duplicate source name: ${s.name}`);
		names.add(s.name);
		const nn = ndiName(s, config.defaults);
		if (ndiNames.has(nn)) errors.push(`duplicate NDI name: ${nn}`);
		ndiNames.add(nn);
		const a = resolveAudio(s, config.defaults);
		if (a.channelOffset !== undefined && a.channelOffset !== null && a.channelOffset !== '') {
			const off = parseInt(a.channelOffset, 10);
			if (Number.isNaN(off) || off < 0 || off > 7) errors.push(`${label}: channelOffset must be 0-7`);
			if (offsets.has(off) && offsets.get(off) === a.audioOutputDevice) {
				errors.push(`${label}: channelOffset ${off} already used on device "${a.audioOutputDevice}"`);
			}
			offsets.set(off, a.audioOutputDevice);
		}
		const v = resolveVideo(s, config.defaults);
		for (const [k, lo, hi] of [['width', 320, 3840], ['height', 180, 2160], ['fps', 1, 120]]) {
			const n = parseInt(v[k], 10);
			if (Number.isNaN(n) || n < lo || n > hi) errors.push(`${label}: video.${k} out of range (${lo}-${hi})`);
		}
	}
	return errors;
}

module.exports = { videoUrl, audioUrl, ndiName, resolveVideo, resolveAudio, validateConfig, mergedDefaults };
