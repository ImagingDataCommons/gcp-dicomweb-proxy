#!/usr/bin/env node
'use strict';

/*
 * Smoke test for a deployed (or local) proxy:
 *
 *   node smoke-test.js <proxy base URL> [<store resource name or DICOMweb URL>]
 *
 * Walks from /studies to one instance and retrieves its metadata and the instance
 * (multipart and Part 10), then checks that CORS preflight works and that writes and
 * paths outside the store are refused. With the store given and ACCESS_TOKEN set
 * (e.g. ACCESS_TOKEN=$(gcloud auth print-access-token)), it also checks that the
 * proxy returns the same metadata as the store itself.
 *
 * The write checks send DELETE for a made-up UID and POST with an empty body, so
 * they cannot change a store even if pointed at a proxy that forwards writes.
 */

const http = require('node:http');
const https = require('node:https');

const [base, store] = process.argv.slice(2);
if (!base) {
  console.error('usage: node smoke-test.js <proxy base URL> [<store>]');
  process.exit(2);
}

// Reads at most this much of a response; enough to show it streams, and keeps a
// whole-slide image from being downloaded in full.
const MAX_BYTES = 64 * 1024 * 1024;

// Sends the path as given, without normalising it, and returns status, headers, body
// (the first MAX_BYTES of it).
function request(method, url, headers = {}) {
  const u = new URL(url);
  // ID_TOKEN (gcloud auth print-identity-token) tests a proxy that is not public yet.
  if (process.env.ID_TOKEN && !headers.authorization && url.startsWith(base)) {
    headers = {...headers, authorization: `Bearer ${process.env.ID_TOKEN}`};
  }
  const lib = u.protocol === 'http:' ? http : https;
  const rawPath = url.slice(u.origin.length) || '/';
  return new Promise((resolve, reject) => {
    const req = lib.request({
      method, hostname: u.hostname, port: u.port, path: rawPath, headers,
    }, (res) => {
      const chunks = [];
      let size = 0;
      const done = () => resolve({status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).subarray(0, MAX_BYTES)});
      res.on('data', (c) => {
        chunks.push(c);
        size += c.length;
        if (size >= MAX_BYTES) {
          res.removeAllListeners('end');
          res.destroy();
          done();
        }
      });
      res.on('end', done);
    });
    req.on('error', reject);
    req.end();
  });
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const tag = (json, t) => json[t] && json[t].Value && json[t].Value[0];

(async () => {
  const root = base.replace(/\/+$/, '');
  const json = {accept: 'application/dicom+json'};

  const studies = await request('GET', `${root}/studies?limit=1`, json);
  check('QIDO studies', studies.status === 200, `HTTP ${studies.status}`);
  if (studies.status !== 200) process.exit(1);
  const study = tag(JSON.parse(studies.body)[0], '0020000D');

  const series = await request('GET', `${root}/studies/${study}/series?limit=1`, json);
  check('QIDO series', series.status === 200, `HTTP ${series.status}`);
  const seriesUid = tag(JSON.parse(series.body)[0], '0020000E');

  const instances = await request('GET', `${root}/studies/${study}/series/${seriesUid}/instances?limit=1&includefield=00080060`, json);
  check('QIDO instances', instances.status === 200, `HTTP ${instances.status}`);
  const first = JSON.parse(instances.body)[0];
  const sop = tag(first, '00080018');
  const instancePath = `/studies/${study}/series/${seriesUid}/instances/${sop}`;
  console.log(`      instance ${instancePath} (Modality ${tag(first, '00080060')})`);

  const metadata = await request('GET', `${root}${instancePath}/metadata`, json);
  check('WADO metadata', metadata.status === 200, `HTTP ${metadata.status}, ${metadata.body.length} bytes`);

  const instance = await request('GET', `${root}${instancePath}`,
      {accept: 'multipart/related; type="application/dicom"; transfer-syntax=*'});
  check('WADO instance', instance.status === 200 && /multipart\/related/.test(instance.headers['content-type']),
      `HTTP ${instance.status}, ${instance.body.length} bytes`);

  // What a viewer such as SlicerRAD-IDC asks for: a study's SEGs, then one instance as
  // stored, as a single Part-10 file. (Frames are not tested: the Healthcare API does not
  // serve frames of deflated instances, whichever way it is reached.)
  const segs = await request('GET',
      `${root}/studies/${study}/instances?Modality=SEG&limit=5000&includefield=00080060`, json);
  check('QIDO SEG instances in study', segs.status === 200 || segs.status === 204, `HTTP ${segs.status}`);

  const part10 = await request('GET', `${root}${instancePath}`, {accept: 'application/dicom; transfer-syntax=*'});
  const isPart10 = part10.body.length > 132 && part10.body.toString('latin1', 128, 132) === 'DICM';
  check('WADO instance as Part 10', part10.status === 200 && isPart10,
      `HTTP ${part10.status}, ${part10.body.length} bytes`);

  const preflight = await request('OPTIONS', `${root}/studies`, {
    'origin': 'https://viewer.example.org',
    'access-control-request-method': 'GET',
    'access-control-request-headers': 'accept',
  });
  check('CORS preflight', preflight.status === 204 &&
      preflight.headers['access-control-allow-origin'] === '*', `HTTP ${preflight.status}`);
  check('CORS on GET', studies.headers['access-control-allow-origin'] === '*');

  const del = await request('DELETE', `${root}/studies/1.2.3.4.5.6.7.8.9.0.999999`);
  check('DELETE refused', del.status === 405, `HTTP ${del.status}`);
  const post = await request('POST', `${root}/studies`, {'content-length': '0'});
  check('POST (STOW) refused', post.status === 405, `HTTP ${post.status}`);

  const escape = await request('GET', `${root}/studies%2F..%2F..%2F..%2Fstudies`);
  check('encoded path escape refused', escape.status === 400, `HTTP ${escape.status}`);

  if (store && process.env.ACCESS_TOKEN) {
    const direct = store.startsWith('projects/') ?
      `https://healthcare.googleapis.com/v1/${store.replace(/\/+$/, '')}/dicomWeb` : store.replace(/\/+$/, '');
    const ref = await request('GET', `${direct}${instancePath}/metadata`,
        {...json, authorization: `Bearer ${process.env.ACCESS_TOKEN}`});
    check('metadata identical to the store', ref.status === 200 && ref.body.equals(metadata.body),
        `store HTTP ${ref.status}, ${ref.body.length} bytes`);
    const refFile = await request('GET', `${direct}${instancePath}`,
        {accept: 'application/dicom; transfer-syntax=*', authorization: `Bearer ${process.env.ACCESS_TOKEN}`});
    check('Part-10 file identical to the store', refFile.status === 200 && refFile.body.equals(part10.body),
        `store HTTP ${refFile.status}, ${refFile.body.length} bytes`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
