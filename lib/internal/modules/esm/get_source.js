'use strict';

const { getOptionValue } = require('internal/options');
// Do not eagerly grab .manifest, it may be in TDZ
const policy = getOptionValue('--experimental-policy') ?
  require('internal/process/policy') :
  null;

const fs = require('internal/fs/promises').exports;
const { URL } = require('internal/url');
const {
  ERR_INVALID_URL_SCHEME,
} = require('internal/errors').codes;
const { getDataURISource } = require('internal/util');
const readFileAsync = fs.readFile;

async function defaultGetSource(url, { format } = {}, defaultGetSource) {
  const parsed = new URL(url);
  let source;
  if (parsed.protocol === 'file:') {
    source = await readFileAsync(parsed);
  } else if (parsed.protocol === 'data:') {
    source = getDataURISource(url).data;
  } else {
    throw new ERR_INVALID_URL_SCHEME(['file', 'data']);
  }
  if (policy?.manifest) {
    policy.manifest.assertIntegrity(parsed, source);
  }
  return { source };
}
exports.defaultGetSource = defaultGetSource;
