// Flags: --experimental-modules

import '../common';

import assert from 'assert';

import * as ns1 from 'data:text/javascript, export const a = 1';
import * as ns2 from 'data:text/javascript;base64,ZXhwb3J0IGNvbnN0IGEgPSAx';

assert.strictEqual(ns1.a, 1);
assert.strictEqual(ns2.a, 1);
