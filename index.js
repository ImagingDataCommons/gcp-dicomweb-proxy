'use strict';

/*
 * Read-only, unauthenticated DICOMweb proxy for one Google Cloud Healthcare API
 * DICOM store.
 *
 * Every GET or HEAD request is forwarded to the store named by DICOMWEB_URL, with
 * an access token for the service account the function runs as. Nothing else
 * passes: no STOW, no DELETE, no path outside the store. One copy of this code
 * serves any store; the store is chosen per deployment by DICOMWEB_URL (see
 * deploy.sh), so nothing here is edited to deploy a new proxy.
 */

const https = require('node:https');
const {pipeline} = require('node:stream');
const functions = require('@google-cloud/functions-framework');
const {GoogleAuth} = require('google-auth-library');

const STORE_URL = /^https:\/\/healthcare\.googleapis\.com\/v1(beta1)?\/projects\/[^/]+\/locations\/[^/]+\/datasets\/[^/]+\/dicomStores\/[^/]+\/dicomWeb$/;

// Accepts the store's DICOMweb URL or its resource name
// (projects/<p>/locations/<l>/datasets/<d>/dicomStores/<s>).
function parseTarget(value) {
  let url = (value || '').trim().replace(/\/+$/, '');
  if (url.startsWith('projects/')) {
    url = `https://healthcare.googleapis.com/v1/${url}/dicomWeb`;
  }
  if (!STORE_URL.test(url)) {
    throw new Error(
      'DICOMWEB_URL must be a DICOM store resource name or its DICOMweb URL, e.g. ' +
      'projects/P/locations/L/datasets/D/dicomStores/S; got: ' + JSON.stringify(value));
  }
  return url;
}

// Fails at startup, so a deployment without a valid store never goes live.
const TARGET = parseTarget(process.env.DICOMWEB_URL);

// Caches the token and refreshes it before it expires.
const auth = new GoogleAuth({scopes: ['https://www.googleapis.com/auth/cloud-platform']});
const agent = new https.Agent({keepAlive: true, maxSockets: 64});

// Request headers passed upstream. Everything else, Authorization included, is dropped.
const FORWARD_REQUEST_HEADERS = [
  'accept', 'accept-encoding', 'range', 'if-range', 'if-none-match', 'if-modified-since',
];

// Response headers not passed back: hop-by-hop headers, cookies, upstream CORS
// headers (this proxy sets its own) and Alt-Svc (it advertises googleapis.com).
const DROP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'set-cookie', 'alt-svc',
]);

// Cloud Run refuses a non-streamed response over 32 MiB. Dropping Content-Length
// above that size makes the response chunked, which has no limit.
const MAX_FIXED_LENGTH = 32 * 1024 * 1024;

const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';

// The path must stay inside the store: no dot segments, no encoded slashes.
function isSafePath(path) {
  if (!path.startsWith('/') || /%2f|%5c|\\/i.test(path)) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  return !decoded.split('/').some((segment) => segment === '..' || segment === '.');
}

function setCorsHeaders(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Expose-Headers',
      'Content-Type, Content-Length, Content-Range, Content-Encoding, ETag, Warning');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
    const requested = req.get('Access-Control-Request-Headers');
    if (requested) res.set('Access-Control-Allow-Headers', requested);
    res.set('Access-Control-Max-Age', '3600');
  }
}

async function dicomwebProxy(req, res) {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.set('Allow', ALLOWED_METHODS);
    res.status(405).type('text/plain').send('This proxy is read-only.\n');
    return;
  }

  const url = req.url;
  const query = url.indexOf('?');
  const path = query < 0 ? url : url.slice(0, query);
  if (!isSafePath(path)) {
    res.status(400).type('text/plain').send('Invalid path.\n');
    return;
  }

  let token;
  try {
    token = await auth.getAccessToken();
  } catch (err) {
    console.error('Could not get an access token:', err);
    res.status(503).type('text/plain').send('Proxy could not authenticate to the store.\n');
    return;
  }

  const headers = {authorization: `Bearer ${token}`};
  for (const name of FORWARD_REQUEST_HEADERS) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }

  const upstream = https.request(TARGET + url, {method: req.method, headers, agent}, (up) => {
    for (const [name, value] of Object.entries(up.headers)) {
      if (DROP_RESPONSE_HEADERS.has(name) || name.startsWith('access-control-')) continue;
      if (name === 'content-length' && Number(value) > MAX_FIXED_LENGTH) continue;
      res.setHeader(name, value);
    }
    res.status(up.statusCode);
    // Unlike up.pipe(res), pipeline ends the response if the store drops the
    // connection mid-body; with pipe the client would wait until the function's
    // timeout. A response cut short this way, or by a client that cancels (viewers
    // do), is not logged: the client sees the reset, and the two look the same here.
    pipeline(up, res, () => {});
  });

  upstream.on('error', (err) => {
    console.error(`Upstream request failed: ${req.method} ${url}:`, err);
    if (!res.headersSent) {
      res.status(502).type('text/plain').send('The DICOM store could not be reached.\n');
    } else {
      res.destroy(err);
    }
  });
  // Stop reading from the store when the client goes away.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  upstream.end();
}

functions.http('dicomwebProxy', dicomwebProxy);

module.exports = {parseTarget, isSafePath};
