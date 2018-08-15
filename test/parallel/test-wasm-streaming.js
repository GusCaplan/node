'use strict';

const common = require('../common');
const assert = require('assert');
const fixtures = require('../common/fixtures');
const fs = require('fs');

const file = fixtures.path('test.wasm');

function cb({ instance }) {
  assert.strictEqual(instance.exports.addTwo(10, 20), 30);
}

WebAssembly.instantiateStreaming(fs.promises.readFile(file))
  .then(common.mustCall(cb));
WebAssembly.instantiateStreaming(fs.createReadStream(file))
  .then(common.mustCall(cb));

WebAssembly.instantiateStreaming({}).catch(common.expectsError({
  code: 'ERR_INVALID_ARG_TYPE',
}));
