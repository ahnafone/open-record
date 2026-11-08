'use strict';
// rimraf@2 API subset used by `temp` (electron-winstaller -> temp -> rimraf@2).
// Removes a path recursively; `options` is accepted for compatibility and ignored.
const fs = require('node:fs');

const RETRY = { recursive: true, force: true, maxRetries: 6, retryDelay: 100 };

function rimraf(path, options, callback) {
  if (typeof options === 'function') callback = options;
  fs.rm(path, RETRY, (error) => callback(error ?? null));
}

rimraf.sync = function rimrafSync(path) {
  fs.rmSync(path, RETRY);
};

module.exports = rimraf;
