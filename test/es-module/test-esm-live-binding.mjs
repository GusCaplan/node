// Flags: --experimental-modules

import '../common';
import assert from 'assert';

import fs, { readFile } from 'fs';
import events from 'events';
import util from 'util';

const fsDescriptor = Reflect.getOwnPropertyDescriptor(fs, 'readFile');

const s = Symbol();
const fn = () => s;

Reflect.deleteProperty(fs, 'readFile');

assert.strictEqual(fs.readFile, undefined);
assert.strictEqual(readFile, undefined);

fs.readFile = fn;

assert.strictEqual(fs.readFile(), s);
assert.strictEqual(readFile(), s);

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

Reflect.defineProperty(fs, 'readFile', fsDescriptor);

const originDefaultMaxListeners = events.defaultMaxListeners;
const utilProto = util.__proto__; // eslint-disable-line no-proto

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

assert.strictEqual(events.defaultMaxListeners, originDefaultMaxListeners);
assert.strictEqual(++events.defaultMaxListeners,
                   originDefaultMaxListeners + 1);

assert.strictEqual(Function.prototype.defaultMaxListeners, 1);

Function.prototype.defaultMaxListeners = 'foo';

assert.strictEqual(Function.prototype.defaultMaxListeners, 'foo');
assert.strictEqual(events.defaultMaxListeners, originDefaultMaxListeners + 1);

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

assert.strictEqual(util.foo, 1);

util.foo = 'bar';

assert.strictEqual(count, 1);
assert.strictEqual(util.foo, 'bar');
assert.strictEqual(p.foo, 2);

p.foo = 'foo';

assert.strictEqual(p.foo, 'foo');

events.defaultMaxListeners = originDefaultMaxListeners;
util.__proto__ = utilProto; // eslint-disable-line no-proto

Reflect.deleteProperty(util, 'foo');
Reflect.deleteProperty(Function.prototype, 'defaultMaxListeners');

assert.throws(
  () => Object.defineProperty(events, 'defaultMaxListeners', { value: 3 }),
  /TypeError: Cannot redefine/
);
