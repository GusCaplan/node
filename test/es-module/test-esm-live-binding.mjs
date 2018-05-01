// Flags: --experimental-modules

import '../common';
import assert from 'assert';

import fs, { readFile } from 'fs';
import events from 'events';
import util from 'util';

const s = Symbol();
const fn = () => s;

delete fs.readFile;
assert.strictEqual(fs.readFile, undefined);
assert.strictEqual(readFile, undefined);

fs.readFile = fn;

assert.strictEqual(fs.readFile(), s);
assert.strictEqual(readFile(), s);

Reflect.deleteProperty(fs, 'readFile');

Reflect.defineProperty(fs, 'readFile', {
  value: fn,
  configurable: true,
  writable: true,
});

assert.strictEqual(fs.readFile(), s);
assert.strictEqual(readFile(), s);

Reflect.deleteProperty(fs, 'readFile');
assert.strictEqual(fs.readFile, undefined);
assert.strictEqual(readFile, undefined);

Reflect.defineProperty(fs, 'readFile', {
  get() { return fn; },
  set() {},
  configurable: true,
});

assert.strictEqual(fs.readFile(), s);
assert.strictEqual(readFile(), s);

assert.throws(() => {
  Object.defineProperty(events, 'defaultMaxListeners', { value: 3 });
}, {});

// keep these ones last because they mess with prototypes

let count = 0;
Reflect.defineProperty(Function.prototype, 'defaultMaxListeners', {
  configurable: true,
  enumerable: true,
  get: function() { return ++count; },
  set: function(v) {
    Reflect.defineProperty(this, 'defaultMaxListeners', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: v,
    });
  },
});

assert.strictEqual(10, events.defaultMaxListeners);
assert.strictEqual(11, ++events.defaultMaxListeners);

assert.strictEqual(1, Function.prototype.defaultMaxListeners);
assert.strictEqual(2, Function.prototype.defaultMaxListeners);
Function.prototype.defaultMaxListeners = 'foo';
assert.strictEqual('foo', Function.prototype.defaultMaxListeners);

assert.strictEqual(11, events.defaultMaxListeners);

count = 0;
const p = {
  get foo() { return ++count; },
  set foo(v) {
    Reflect.defineProperty(this, 'foo', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: v,
    });
  },
};

util.__proto__ = p; // eslint-disable-line no-proto

assert.strictEqual(1, util.foo);
util.foo = 'bar';
assert.strictEqual(1, count);
assert.strictEqual('bar', util.foo);
assert.strictEqual(2, p.foo);
assert.strictEqual(3, p.foo);
p.foo = 'foo';
assert.strictEqual('foo', p.foo);
