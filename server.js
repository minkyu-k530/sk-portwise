// SK PortWise: 정적 파일 + /api 중계 서버 (의존성 없음, Node 20+)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getCongestion,
  getFacilities,
  getLayer,
  getSeaFog,
  getShipping,
  getVesselDetail,
  getVesselRoute,
  getVessels,
  getWeather,
} from './lib/sk.js';

const PORT = Number(process.env.PORT) || 5050;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

const MMSI_RE = /^\d{9}$/;

/** @type {Array<[RegExp, (m: RegExpMatchArray, url: URL) => Promise<unknown>]>} */
const ROUTES = [
  [/^\/api\/vessels$/, () => getVessels()],
  [/^\/api\/vessels\/([^/]+)\/detail$/, (m, url) => {
    if (!MMSI_RE.test(m[1])) throw Object.assign(new Error('invalid mmsi'), { status: 400 });
    return getVesselDetail(m[1], url.searchParams.get('callSign'));
  }],
  [/^\/api\/vessels\/([^/]+)\/route$/, (m) => {
    if (!MMSI_RE.test(m[1])) throw Object.assign(new Error('invalid mmsi'), { status: 400 });
    return getVesselRoute(m[1]);
  }],
  [/^\/api\/facilities$/, () => getFacilities()],
  [/^\/api\/weather$/, () => getWeather()],
  [/^\/api\/seafog$/, () => getSeaFog()],
  [/^\/api\/shipping$/, () => getShipping()],
  [/^\/api\/congestion$/, (_m, url) => getCongestion(url.searchParams.get('date') ?? '', url.searchParams.get('time') ?? '')],
  [/^\/api\/layers\/([a-z]+)$/, (m) => getLayer(m[1])],
  [/^\/api\/health$/, async () => ({ ok: true, time: new Date().toISOString() })],
];

async function handleApi(req, res, url) {
  for (const [re, handler] of ROUTES) {
    const m = url.pathname.match(re);
    if (!m) continue;
    try {
      sendJson(res, 200, await handler(m, url));
    } catch (err) {
      const status = err.status ?? 502;
      if (status >= 500) console.error(`[api] ${url.pathname}: ${err.message}`);
      sendJson(res, status, { error: err.message });
    }
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

async function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  if (url.pathname.startsWith('/api/')) handleApi(req, res, url);
  else handleStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`SK PortWise listening on http://${HOST}:${PORT}`);
});
