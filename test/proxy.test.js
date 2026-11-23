'use strict';

const test = require('node:test');
const assert = require('node:assert');

const STORE = 'projects/p/locations/l/datasets/d/dicomStores/s';
process.env.DICOMWEB_URL = STORE;
const {parseTarget, isSafePath} = require('../index.js');

test('parseTarget accepts a resource name or a DICOMweb URL', () => {
  const url = `https://healthcare.googleapis.com/v1/${STORE}/dicomWeb`;
  assert.strictEqual(parseTarget(STORE), url);
  assert.strictEqual(parseTarget(`${STORE}/`), url);
  assert.strictEqual(parseTarget(url), url);
  assert.strictEqual(parseTarget(`${url}/`), url);
  const beta = `https://healthcare.googleapis.com/v1beta1/${STORE}/dicomWeb`;
  assert.strictEqual(parseTarget(beta), beta);
});

test('parseTarget rejects anything that is not one DICOM store', () => {
  for (const bad of [undefined, '', 'https://example.org/dicomWeb',
    `https://healthcare.googleapis.com/v1/${STORE}`,
    'https://healthcare.googleapis.com/v1/projects/p/locations/l/datasets/d/dicomWeb']) {
    assert.throws(() => parseTarget(bad), /DICOMWEB_URL/, String(bad));
  }
});

test('isSafePath keeps requests inside the store', () => {
  for (const ok of ['/studies', '/studies/1.2.3/series/4.5/instances/6.7/frames/1',
    '/studies/1.2.3/series/4.5/metadata', '/']) {
    assert.ok(isSafePath(ok), ok);
  }
  for (const bad of ['studies', '/../x', '/studies/../../x', '/%2e%2e/x', '/.%2E/x',
    '/studies%2f..%2fx', '/studies%2F1', '/a\\b', '/./studies', '/%zz']) {
    assert.ok(!isSafePath(bad), bad);
  }
});
