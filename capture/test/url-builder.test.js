// Test 1 (SESSION4-SPEC §4): url-builder assertions. Plain node, no deps.
//   node capture/test/url-builder.test.js
'use strict';
const { videoUrl, audioUrl, ndiName, validateConfig, normalizeDeviceLabel, deviceMatches, sameDevice } = require('../url-builder');

const cfg = {
  defaults: {
    room: 'tavern',
    vdoBase: 'https://vdo.ninja/',
    ndiPrefix: 'CC-',
    video: { width: 1920, height: 1080, fps: 30 },
    audio: { audioOutputDevice: 'VAIO' },
  },
  sources: [
    { name: 'Alice', streamId: 'alice01',
      video: { fps: 60 }, audio: { channelOffset: 0 } },
    { name: 'Bob', streamId: 'bob02', room: 'sideroom',
      video: { ndiName: 'CustomBob', width: 1280, height: 720 },
      audio: { channelOffset: 1, extraParams: '&buffer=120' } },
    { name: 'Cara', streamId: 'cara03', room: '',
      video: { extraParams: 'scale=100' },
      audio: { audioOutputDevice: 'Speakers (MOTU)', channelOffset: 5 } },
  ],
};

let failures = 0;
function eq(label, actual, expected) {
  if (actual === expected) { console.log(`  ok  ${label}`); return; }
  failures++;
  console.error(`FAIL  ${label}\n      expected: ${expected}\n      actual:   ${actual}`);
}

const [alice, bob, cara] = cfg.sources;

eq('alice video url', videoUrl(alice, cfg.defaults),
  'https://vdo.ninja/?view=alice01&room=tavern&noaudio');
eq('alice audio url', audioUrl(alice, cfg.defaults),
  'https://vdo.ninja/?view=alice01&room=tavern&novideo&audiooutput=VAIO&channels=8&channeloffset=0');
eq('alice ndi name (prefix fallback)', ndiName(alice, cfg.defaults), 'CC-Alice');

eq('bob video url (room override)', videoUrl(bob, cfg.defaults),
  'https://vdo.ninja/?view=bob02&room=sideroom&noaudio');
eq('bob audio url (extraParams)', audioUrl(bob, cfg.defaults),
  'https://vdo.ninja/?view=bob02&room=sideroom&novideo&audiooutput=VAIO&channels=8&channeloffset=1&buffer=120');
eq('bob ndi name (explicit)', ndiName(bob, cfg.defaults), 'CustomBob');

eq('cara video url (extra without &, empty room stays inherited-empty)', videoUrl(cara, cfg.defaults),
  'https://vdo.ninja/?view=cara03&room=tavern&noaudio&scale=100');
eq('cara audio url (device label encoded)', audioUrl(cara, cfg.defaults),
  'https://vdo.ninja/?view=cara03&room=tavern&novideo&audiooutput=Speakers%20(MOTU)&channels=8&channeloffset=5');

const errs = validateConfig(cfg);
eq('valid config has no errors', errs.join(';'), '');

const badErrs = validateConfig({
  defaults: cfg.defaults,
  sources: [
    { name: 'Dup', streamId: 'x', audio: { channelOffset: 0 } },
    { name: 'Dup', streamId: '', audio: { channelOffset: 9 } },
  ],
});
eq('bad config error count', String(badErrs.length >= 3), 'true');

// Session 10: device-identity normalization (vdo.ninja's own rule everywhere)
eq('normalize matches vdo.ninja rule', normalizeDeviceLabel('VBMatrix In 6 (VB-Audio Matrix VAIO)'),
  'vbmatrix_in_6_vb_audio_matrix_vaio_');
eq('fragment matches its full label', String(deviceMatches('VBMatrix In 6', 'VBMatrix In 6 (VB-Audio Matrix VAIO)')), 'true');
eq('fragment does not match another endpoint', String(deviceMatches('VBMatrix In 6', 'Out 3-4 (MOTU M Series)')), 'false');
eq('sameDevice: fragment vs full label', String(sameDevice('VBMatrix In 6', 'VBMatrix In 6 (VB-Audio Matrix VAIO)')), 'true');
eq('sameDevice: different endpoints', String(sameDevice('VBMatrix In 6', 'VBMatrix In 5')), 'false');
eq('sameDevice: empty never matches', String(sameDevice('', 'VBMatrix In 6')), 'false');

// offset conflict across fragment/full-label spellings of ONE physical endpoint
const spellErrs = validateConfig({
  defaults: cfg.defaults,
  sources: [
    { name: 'A', streamId: 'a', audio: { audioOutputDevice: 'VBMatrix In 6', channelOffset: 3 } },
    { name: 'B', streamId: 'b', audio: { audioOutputDevice: 'VBMatrix In 6 (VB-Audio Matrix VAIO)', channelOffset: 3 } },
  ],
});
eq('same physical endpoint, same offset -> conflict', String(spellErrs.length), '1');

// genuinely different devices may share an offset
const multiDevErrs = validateConfig({
  defaults: cfg.defaults,
  sources: [
    { name: 'A', streamId: 'a', audio: { audioOutputDevice: 'VBMatrix In 6', channelOffset: 3 } },
    { name: 'B', streamId: 'b', audio: { audioOutputDevice: 'Out 3-4 (MOTU M Series)', channelOffset: 3 } },
  ],
});
eq('different devices, same offset -> ok', spellErrs.length === 1 ? multiDevErrs.join(';') : 'skipped', '');

// the Session 8 hole: per-offset map only remembered the LAST device seen —
// A(devX off0), B(devY off0), C(devX off0) must flag A vs C
const holeErrs = validateConfig({
  defaults: cfg.defaults,
  sources: [
    { name: 'A', streamId: 'a', audio: { audioOutputDevice: 'VBMatrix In 6', channelOffset: 0 } },
    { name: 'B', streamId: 'b', audio: { audioOutputDevice: 'Out 3-4 (MOTU M Series)', channelOffset: 0 } },
    { name: 'C', streamId: 'c', audio: { audioOutputDevice: 'VBMatrix In 6', channelOffset: 0 } },
  ],
});
eq('multi-device offset hole is closed', String(holeErrs.length), '1');

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('url-builder: ALL PASS');
