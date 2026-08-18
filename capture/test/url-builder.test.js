// Test 1 (SESSION4-SPEC §4): url-builder assertions. Plain node, no deps.
//   node capture/test/url-builder.test.js
'use strict';
const { videoUrl, audioUrl, ndiName, validateConfig } = require('../url-builder');

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

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('url-builder: ALL PASS');
