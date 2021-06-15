// PORTIONS OF THIS CODE LICENSED FROM "node-fetch" AS FOLLOWS:
// """
// The MIT License (MIT)
//
// Copyright (c) 2016 - 2020 Node Fetch Team
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// """

// PORTIONS OF THIS CODE LICENSED FROM "jsdom" AS FOLLOWS:
// """
// Copyright (c) 2010 Elijah Insua
//
// Permission is hereby granted, free of charge, to any person
// obtaining a copy of this software and associated documentation
// files (the "Software"), to deal in the Software without
// restriction, including without limitation the rights to use,
// copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the
// Software is furnished to do so, subject to the following
// conditions:
//
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
// OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
// HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
// WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
// OTHER DEALINGS IN THE SOFTWARE.
// """

'use strict';

const {
  ArrayBufferIsView,
  ArrayFrom,
  ArrayIsArray,
  ArrayPrototypeForEach,
  ArrayPrototypeJoin,
  ArrayPrototypePush,
  ArrayPrototypeReduce,
  Error,
  JSONParse,
  NumberIsNaN,
  ObjectDefineProperties,
  ObjectEntries,
  Promise,
  SafeMap,
  SafeSet,
  String,
  Symbol,
  SymbolToStringTag,
  TypeError,
} = primordials;
const {
  codes: {
    ERR_STREAM_PREMATURE_CLOSE,
    ERR_OUT_OF_RANGE,
  },
} = require('internal/errors');
const assert = require('internal/assert');
const { isAnyArrayBuffer } = require('internal/util/types');
const { getDataURISource, removeColors } = require('internal/util');
const { toUSVString } = require('internal/url');
const { AbortController } = require('internal/abort_controller');
const util = require('util');
const { Buffer, Blob } = require('buffer');
const Stream = require('stream');
const { ReadableStream } = require('stream/web');
const tls = require('tls');
const http = require('http');
const https = require('https');
const http2 = require('http2');
const { URL } = require('url');
const zlib = require('zlib');

class AbortError extends Error {}

function validateName(name) {
  if (!name.match(/^[!#$%&'*+\-.^`|~\w]+$/)) {
    throw new ERR_OUT_OF_RANGE('name', 'a valid header name', name);
  }
  return toUSVString(name).toLowerCase();
}

function validateValue(value) {
  value = toUSVString(value)
    .replace(/^[\r\n\t ]+/g, '')
    .replace(/[\r\n\t ]+$/, '');
  if (/[\0\r\n]/.test(value)) {
    throw new ERR_OUT_OF_RANGE('name', 'a valid header value', value);
  }
  return value;
}

const SUPPORTED_PROTOCOLS = new SafeSet(['data:', 'http:', 'https:']);
const REDIRECTS = new SafeSet([301, 302, 303, 307, 308]);

class Headers {
  #headers = new SafeMap();

  constructor(init = undefined) {
    if (init) {
      if (init instanceof Headers) {
        this.#headers = new SafeMap([...init.#headers]);
      } else if (ArrayIsArray(init)) {
        for (const header of init) {
          if (header.length !== 2) {
            throw new ERR_OUT_OF_RANGE();
          }
          this.append(header[0], header[1]);
        }
      } else {
        for (const pair of ObjectEntries(init)) {
          this.append(pair[0], pair[1]);
        }
      }
    }
  }

  append(name, value) {
    value = validateValue(value);
    name = validateName(name);
    const existing = this.#headers.get(name.toLowerCase());
    if (existing) {
      existing.push(value);
    } else {
      this.#headers.set(name.toLowerCase(), [value]);
    }
  }

  delete(name) {
    name = validateName(name);
    this.#headers.delete(name);
  }

  get(name) {
    name = validateName(name);
    const values = this.#headers.get(name);
    if (!values) {
      return null;
    }
    return values.join(', ');
  }

  has(name) {
    name = validateName(name);
    return this.#headers.has(name);
  }

  set(name, value) {
    value = validateValue(value);
    name = validateName(name);
    this.#headers.set(name, [value]);
  }

  [util.inspect.custom](recurseTimes, ctx) {
    const separator = ', ';
    const innerOpts = { ...ctx };
    if (recurseTimes !== null) {
      innerOpts.depth = recurseTimes - 1;
    }
    const innerInspect = (v) => util.inspect(v, innerOpts);

    const output = [];
    this.#headers.forEach((v, k) => {
      ArrayPrototypePush(
        output,
        `${innerInspect(k)} => ${v.length === 1 ? innerInspect(v[0]) : innerInspect(v)}`);
    });
    const length = ArrayPrototypeReduce(
      output,
      (prev, cur) => prev + removeColors(cur).length + separator.length,
      -separator.length
    );
    if (length > ctx.breakLength) {
      return `${this.constructor.name} {\n` +
      `  ${ArrayPrototypeJoin(output, ',\n  ')} }`;
    } else if (output.length) {
      return `${this.constructor.name} { ` +
      `${ArrayPrototypeJoin(output, separator)} }`;
    }
    return `${this.constructor.name} {}`;
  }

  static getRawHeaders(headers) {
    const result = {};
    for (const { 0: key, 1: values } of headers.#headers.entries()) {
      if (key === 'host') {
        result[key] = values[0];
      } else {
        result[key] = values.length > 1 ? values : values[0];
      }
    }
    return result;
  }
}

const getRawHeaders = Headers.getRawHeaders;
delete Headers.getRawHeaders;

class BodyDisturbedError extends TypeError {
  constructor() {
    super('body was already consumed');
  }
}

function extractBody(object) {
  if (typeof object === 'object') {
    if (ArrayBufferIsView(object)) {
      return new ReadableStream({
        type: 'bytes',
        start(controller) {
          controller.enqueue(object);
          controller.close();
        },
      });
    }

    if (isAnyArrayBuffer(object)) {
      const body = Buffer.from(object);
      return new ReadableStream({
        type: 'bytes',
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      });
    }

    if (object instanceof Stream) {
      // return object.toWeb();
      return new ReadableStream({
        type: 'bytes',
        start(controller) {
          object.on('data', (d) => controller.enqueue(d));
          object.once('end', () => controller.close());
          object.once('error', (e) => controller.error(e));
        },
        pull(controller) {
          const r = object.read();
          if (r !== null) {
            controller.enqueue(r);
          }
        },
      });
    }

    if (object[SymbolToStringTag] === 'ReadableStream') {
      if (object.disturbed || object.locked) {
        // eslint-disable-next-line no-restricted-syntax
        throw new BodyDisturbedError();
      }
      return object;
    }

    if (object[SymbolToStringTag] === 'URLSearchParams') {
      return new ReadableStream({
        type: 'bytes',
        start(controller) {
          controller.enqueue(Buffer.from(object.toString()));
          controller.close();
        },
      });
    }

    if (object[SymbolToStringTag] === 'Blob') {
      const promise = object.arrayBuffer();
      return new ReadableStream({
        type: 'bytes',
        start(controller) {
          promise.then((value) => {
            controller.enqueue(value);
            controller.close();
          });
        },
      });
    }
  }

  const body = Buffer.from(String(object));
  return new ReadableStream({
    type: 'bytes',
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
}

class Body {
  #body = null;
  #disturbed = false;
  #error;
  #size;

  constructor(body = null, { size = 0 } = {}) {
    if (new.target === Body) {
      // eslint-disable-next-line no-restricted-syntax
      throw new TypeError('Illegal constructor');
    }

    if (body !== null) {
      this.#body = extractBody(body);
    }

    this.#size = size;
  }

  get body() {
    return this.#body;
  }

  get bodyUsed() {
    return this.#disturbed;
  }

  get size() {
    return this.#size;
  }

  async arrayBuffer() {
    const { buffer, byteOffset, byteLength } = await consumeBody(this);
    return buffer.slice(byteOffset, byteOffset + byteLength);
  }

  async blob() {
    const buffer = await consumeBody(this);
    const type = this.headers?.get('content-type') || this.#body.type || '';
    return new Blob([buffer], { type });
  }

  async json() {
    const buffer = await consumeBody(this);
    return JSONParse(buffer.toString());
  }

  async text() {
    const buffer = await consumeBody(this);
    return buffer.toString();
  }

  static async consumeBody(body) {
    if (body.#disturbed) {
      // eslint-disable-next-line no-restricted-syntax
      throw new BodyDisturbedError();
    }
    body.#disturbed = true;

    if (body.#error) {
      throw body.#error;
    }

    const data = body.#body;

    if (data === null) {
      return Buffer.alloc(0);
    }

    const chunks = [];
    let bytes = 0;
    for await (const chunk of data) {
      if (body.size > 0 && bytes + chunk.length > body.size) {
        const e = new ERR_OUT_OF_RANGE('body', `<= ${body.size}`, bytes + chunk.length);
        data.destroy(e);
        throw e;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    }

    return Buffer.concat(chunks, bytes);
  }

  static setBody(instance, body) {
    instance.#body = body;
  }
}

const consumeBody = Body.consumeBody;
delete Body.consumeBody;
const setBody = Body.setBody;
delete Body.setBody;

ObjectDefineProperties(Body.prototype, {
  body: { enumerable: true },
  bodyUsed: { enumerable: true },
  arrayBuffer: { enumerable: true },
  blob: { enumerable: true },
  json: { enumerable: true },
  text: { enumerable: true }
});

function cloneBody(instance) {
  if (instance.body.bodyUsed) {
    // eslint-disable-next-line no-restricted-syntax
    throw new BodyDisturbedError();
  }

  if (instance.body !== null) {
    const { 0: l, 1: r } = instance.body.tee();
    setBody(instance, r);
    return l;
  }

  return instance.body;
}

function extractContentType(body, request) {
  if (body === null) {
    return null;
  }

  if (typeof body === 'string') {
    return 'text/plain;charset=UTF-8';
  }

  if (body[SymbolToStringTag] === 'URLSearchParams') {
    return 'application/x-www-form-urlencoded;charset=UTF-8';
  }

  if (body[SymbolToStringTag] === 'Body') {
    return body.type || null;
  }

  if (Buffer.isBuffer(body) ||
      isAnyArrayBuffer(body) ||
      ArrayBufferIsView(body)) {
    return null;
  }

  if (body instanceof Stream) {
    return null;
  }

  return 'text/plain;charset=UTF-8';
}

function getTotalBytes(request) {
  if (request.body === null) {
    return 0;
  }

  if (request.body[SymbolToStringTag] === 'Blob') {
    return request.body.size;
  }

  if (Buffer.isBuffer(request.body)) {
    return request.body.length;
  }

  return null;
}

const kRedirects = Symbol('kRedirects');

class Request extends Body {
  #parsedURL;
  #method;
  #headers;
  #signal;
  #redirect;
  #redirects;

  constructor(input, init = {}) {
    let parsedURL;
    if (typeof input === 'string') {
      parsedURL = new URL(input);
    } else {
      parsedURL = new URL(input.url);
    }

    const method = (init.method || input.method || 'GET').toUpperCase();

    if (((init.body != null || input instanceof Request) &&
         input.body !== null) &&
        (method === 'GET' || method === 'HEAD')) {
      // eslint-disable-next-line no-restricted-syntax
      throw new TypeError('Request with GET/HEAD method cannot have body');
    }

    const inputBody = init.body ?
      init.body :
      (input instanceof Request && input.body !== null ?
        cloneBody(input) :
        null);

    super(inputBody, {
      size: init.size || input.size || 0,
    });

    this.#parsedURL = parsedURL;
    this.#method = method;
    this.#headers = new Headers(init.headers || input.headers);
    this.#signal = init.signal || input.signal;
    this.#redirect = init.redirect || input.redirect || 'follow';
    this.#redirects = init[kRedirects] || 0;

    if (inputBody !== null && !this.#headers.has('Content-Type')) {
      const contentType = extractContentType(inputBody, this);
      if (contentType) {
        this.#headers.append('Content-Type', contentType);
      }
    }
  }

  get url() {
    return this.#parsedURL.toString();
  }

  get method() {
    return this.#method;
  }

  get headers() {
    return this.#headers;
  }

  get redirect() {
    return this.#redirect;
  }

  clone() {
    return new Request(this);
  }

  static getParsedURL(request) {
    return request.#parsedURL;
  }

  static getRedirects(request) {
    return request.#redirects;
  }

  get [SymbolToStringTag]() {
    return 'Request';
  }
}

const getParsedURL = Request.getParsedURL;
delete Request.getParsedURL;
const getRedirects = Request.getRedirects;
delete Request.getRedirects;

ObjectDefineProperties(Request.prototype, {
  method: { enumerable: true },
  url: { enumerable: true },
  headers: { enumerable: true },
  redirect: { enumerable: true },
  clone: { enumerable: true },
  signal: { enumerable: true }
});

class Response extends Body {
  #url;
  #status;
  #headers;
  #redirects;

  constructor(body = null, options = {}) {
    super(body, options);

    this.#url = options.url;
    this.#status = options.status ?? 200;
    this.#headers = new Headers(options.headers);
    this.#redirects = options[kRedirects] || 0;
  }

  get type() {
    return 'default';
  }

  get url() {
    return this.#url;
  }

  get status() {
    return this.#status;
  }

  get ok() {
    return this.#status >= 200 && this.#status < 300;
  }

  get headers() {
    return this.#headers;
  }

  get redirected() {
    return this.#redirects > 0;
  }

  clone() {
    return new Response(cloneBody(this), this);
  }

  get [SymbolToStringTag]() {
    return 'Response';
  }
}

ObjectDefineProperties(Response.prototype, {
  type: { enumerable: true },
  url: { enumerable: true },
  status: { enumerable: true },
  ok: { enumerable: true },
  redirected: { enumerable: true },
  statusText: { enumerable: true },
  headers: { enumerable: true },
  clone: { enumerable: true }
});

function getNodeRequestOptions(request) {
  const parsedURL = getParsedURL(request);
  const headers = new Headers(request.headers);

  if (!headers.has('Accept')) {
    headers.set('Accept', '*/*');
  }

  let contentLengthValue = null;
  if (request.body === null && /^(post|put)$/i.test(request.method)) {
    contentLengthValue = '0';
  }

  if (request.body !== null) {
    const totalBytes = getTotalBytes(request);
    if (typeof totalBytes === 'number' && !NumberIsNaN(totalBytes)) {
      contentLengthValue = String(totalBytes);
    }
  }

  if (contentLengthValue) {
    headers.set('Content-Length', contentLengthValue);
  }

  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', `Node.js fetch ${process.version}`);
  }

  if (!headers.has('Accept-Encoding')) {
    headers.set('Accept-Encoding', 'br,gzip,deflate');
  }

  return {
    path: parsedURL.pathname + parsedURL.search,
    pathname: parsedURL.pathname,
    hostname: parsedURL.hostname,
    host: parsedURL.host,
    protocol: parsedURL.protocol,
    port: parsedURL.port || undefined,
    hash: parsedURL.hash,
    search: parsedURL.search,
    query: parsedURL.query,
    href: parsedURL.href,
    method: request.method,
    headers: getRawHeaders(headers),
  };
}

function fixResponseChunkedTransferBadEnding(request, errorCallback) {
  const LAST_CHUNK = Buffer.from('0\r\n');
  let socket;

  request.on('socket', (s) => {
    socket = s;
  });

  request.on('response', (response) => {
    const { headers } = response;
    if (headers['transfer-encoding'] === 'chunked' &&
        !headers['content-length']) {
      let properLastChunkReceived = false;

      socket.on('data', (buf) => {
        properLastChunkReceived =
          Buffer.compare(buf.slice(-3), LAST_CHUNK) === 0;
      });

      socket.prependListener('close', () => {
        if (!properLastChunkReceived) {
          errorCallback(new ERR_STREAM_PREMATURE_CLOSE());
        }
      });
    }
  });
}

function open(options, signal, onResponse) {
  return new Promise((resolve, reject) => {
    if (options.protocol === 'http:') {
      // TODO: h2c upgrade
      const request = http.request(options);
      signal.addEventListener('abort', () => request.destroy(), { once: true });
      request.once('response', (r) => {
        onResponse(r.headers, r, r);
      });
      resolve({ request, protocol: 1 });
      return;
    }

    const socket = tls.connect({
      host: options.host,
      port: options.port ?? 443,
      servername: options.host,
      ALPNProtocols: ['h2', 'http/1.1'],
    });

    socket.once('error', reject);

    socket.once('secureConnect', () => {
      switch (socket.alpnProtocol) {
        case false:
        case 'http/1.1': {
          const request = https.request({
            ...options,
            createConnection: () => socket,
          });
          signal.addEventListener(
            'abort', () => request.destroy(), { once: true });
          request.once('response', (r) => {
            onResponse(r.headers, r, r);
          });
          resolve({ request, protocol: 1 });
          break;
        }
        case 'h2': {
          const connection = http2.connect({
            host: options.host,
            port: options.port,
          }, {
            createConnection: () => socket,
          });
          connection.once('error', reject);
          connection.settings({ allowPush: false });
          const request = connection.request({
            ...options.headers,
            ':authority': options.host,
            ':path': options.path,
            ':method': options.method,
          }, { signal });
          request.once('response', (headers) => {
            const status = headers[':status'];
            onResponse(headers, {
              statusCode: status,
              statusMessage: http.STATUS_CODES[status] || '',
            }, request);
            connection.unref();
          });
          resolve({ request, protocol: 2 });
          break;
        }
        default:
          // eslint-disable-next-line no-restricted-syntax
          reject(new Error(`No supported ALPN protocol was negotiated, got ${socket.alpnProtocol}`));
          break;
      }
    });
  });
}

async function fetchImpl(url, options, resolve, reject) {
  const request = new Request(url, options);
  const nodeOptions = getNodeRequestOptions(request);

  if (!SUPPORTED_PROTOCOLS.has(nodeOptions.protocol)) {
    const protocols = ArrayFrom(SUPPORTED_PROTOCOLS).join(', ');
    // eslint-disable-next-line no-restricted-syntax
    reject(new TypeError(`Protocol must be one of ${protocols}`));
    return;
  }

  if (nodeOptions.protocol === 'data:') {
    const { data, mediaType } = getDataURISource(request.url);
    resolve(new Response(data, {
      headers: { 'Content-Type': mediaType },
    }));
    return;
  }

  const { signal } = request;
  let response;

  const abort = () => {
    const error = new AbortError();
    reject(error);
    if (request.body instanceof Stream.Readable) {
      request.body.destroy(error);
    }
    response?.body?.emit('error', error);
  };

  if (signal?.aborted) {
    abort();
    return;
  }

  const abortAndFinalize = () => {
    abort();
    finalize();
  };

  const onResponse = (rawHeaders, meta, stream) => {
    nodeRequest.setTimeout(0);

    const headers = new Headers();
    ObjectEntries(rawHeaders).forEach((pair) => {
      try {
        pair[0] = validateName(pair[0]);
        if (ArrayIsArray(pair[1])) {
          ArrayPrototypeForEach(pair[1], (v, i) => {
            pair[1][i] = validateValue(v);
          });
          ArrayPrototypeForEach(pair[1], (v) => {
            headers.append(pair[0], v);
          });
        } else {
          pair[1] = validateValue(pair[1]);
          headers.set(pair[0], pair[1]);
        }
      } catch {
        // skip invalid headers
      }
    });

    if (REDIRECTS.has(meta.statusCode)) {
      const redirectCount = getRedirects(request);
      if (redirectCount > 5) {
        reject(new Error('too many redirects'));
        finalize();
        return;
      }

      const location = headers.get('Location');
      const locationURL = location === null ?
        null :
        new URL(location, request.url).toString();
      switch (request.redirect) {
        case 'error':
          reject();
          finalize();
          return;
        case 'manual':
          if (locationURL) {
            headers.set('Location', locationURL);
          }
          break;
        case 'follow':
          if (!locationURL) {
            break;
          }

          if (meta.statusCode !== 303 &&
              request.body &&
              options.body instanceof Stream.Readable) {
            // eslint-disable-next-line no-restricted-syntax
            reject(new BodyDisturbedError());
            finalize();
            return;
          }

          const requestOptions = {
            headers: new Headers(request.headers),
            redirect: request.redirect,
            method: request.method,
            body: request.body,
            signal: request.signal,
            size: request.size,
            [kRedirects]: redirectCount + 1,
          };

          if (meta.statusCode === 303 ||
              ((meta.statusCode === 301 || meta.statusCode === 302) &&
               request.method === 'POST')) {
            requestOptions.method = 'GET';
            requestOptions.body = undefined;
            requestOptions.headers.delete('content-length');
          }

          resolve(fetch(locationURL, requestOptions));
          finalize();
          return;
        default:
          assert(false);
      }
    }

    if (signal) {
      stream.once('end', () => {
        signal.off('abort', abortAndFinalize);
      });
    }

    const body = Stream.pipeline(stream, new Stream.PassThrough(), reject);

    const responseOptions = {
      url: request.url,
      status: meta.statusCode,
      statusText: meta.statusMessage,
      headers,
      size: request.size,
      [kRedirects]: getRedirects(request),
    };

    const codings = headers.get('Content-Encoding');

    if (request.method === 'HEAD' ||
        codings === null ||
        meta.statusCode === 204 ||
        meta.statusCode === 304) {
      response = new Response(body, responseOptions);
      resolve(response);
      return;
    }

    if (codings === 'gzip' || codings === 'x-gzip') {
      const unzip = Stream.pipeline(body, zlib.createGunzip({
        flush: zlib.Z_SYNC_FLUSH,
        finishFlush: zlib.Z_SYNC_FLUSH
      }), reject);
      response = new Response(unzip, responseOptions);
      resolve(response);
      return;
    }

    if (codings === 'deflate' || codings === 'x-deflate') {
      body.once('data', (chunk) => {
        let deflate;
        if ((chunk[0] & 0x0F) === 0x08) {
          deflate = Stream.pipeline(body, zlib.createInflate(), reject);
        } else {
          deflate = Stream.pipeline(body, zlib.createInflateRaw(), reject);
        }

        response = new Response(deflate, responseOptions);
        resolve(response);
      });
      return;
    }

    if (codings === 'br') {
      const decompress = Stream.pipeline(
        body, zlib.createBrotliDecompress(), reject);
      response = new Response(decompress, responseOptions);
      resolve(response);
      return;
    }

    response = new Response(body, responseOptions);
    resolve(response);
  };

  const internalController = new AbortController();

  const {
    request: nodeRequest,
    protocol,
  } = await open(nodeOptions, internalController.signal, onResponse);

  const finalize = () => {
    internalController.abort();
    signal?.removeEventListener('abort', abortAndFinalize, { once: true });
  };

  signal?.addEventListener('abort', abortAndFinalize, { once: true });

  nodeRequest.once('error', (e) => {
    reject(e);
    finalize();
  });

  if (protocol === 1) {
    fixResponseChunkedTransferBadEnding(nodeRequest, (e) => {
      response?.body.destroy(e);
    });
  }

  if (request.body === null) {
    nodeRequest.end();
  } else {
    Stream.Readable.from(request.body).pipe(nodeRequest);
  }
}

function fetch(url, options = undefined) {
  return new Promise((resolve, reject) => {
    fetchImpl(url, options, resolve, reject)
      .catch(reject);
  });
}

module.exports = {
  fetch,
  Body,
  Request,
  Response,
  Headers,
};
