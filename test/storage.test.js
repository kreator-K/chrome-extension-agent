const assert = require('assert');

global.self = global;
const values = {};
let nextError = '';
global.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get(keys, callback) {
        if (nextError) {
          chrome.runtime.lastError = { message: nextError };
          nextError = '';
          callback({});
          chrome.runtime.lastError = null;
          return;
        }
        const out = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) out[key] = values[key];
        callback(out);
      },
      set(patch, callback) {
        if (nextError) {
          chrome.runtime.lastError = { message: nextError };
          nextError = '';
          callback();
          chrome.runtime.lastError = null;
          return;
        }
        Object.assign(values, patch);
        callback();
      }
    }
  }
};

require('../src/lib/util.js');

(async () => {
  await RA.storage.set({ profile: { firstName: 'Prashant' } });
  assert.deepStrictEqual(await RA.storage.get('profile'), { profile: { firstName: 'Prashant' } });

  nextError = 'QUOTA_BYTES quota exceeded';
  await assert.rejects(RA.storage.set({ applicationResume: { dataUrl: 'x' } }), /QUOTA_BYTES/);

  nextError = 'Extension context invalidated.';
  await assert.rejects(RA.storage.get('profile'), /context invalidated/i);

  console.log('Storage success and failure propagation assertions passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
