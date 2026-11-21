import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const commit = process.env.RELEASE_SHA || 'local';
const runPath = process.env.PUBLIC_RUN_FILE;
const assets = Object.fromEntries(await Promise.all([
  ['/', 'index.html', 'text/html'],
  ['/app.js', 'app.js', 'text/javascript'],
  ['/style.css', 'style.css', 'text/css'],
  ['/preview.json', 'preview.json', 'application/json'],
].map(async ([path, file, type]) => [
  path, [type, await readFile(new URL('../web/' + file, import.meta.url))],
])));

createServer(async (req, res) => {
  const path = req.url?.split('?')[0];
  const send = (status, type, body) => {
    res.writeHead(status, {
      'Content-Type': type + '; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD');
    return send(405, 'text/plain', 'Method not allowed');
  }
  if (path === '/healthz') return send(200, 'application/json', JSON.stringify({ ok: true, commit }));
  if (path === '/run.json' && runPath) {
    try {
      return send(200, 'application/json', await readFile(runPath));
    } catch {
      return send(404, 'text/plain', 'No published run');
    }
  }
  if (Object.hasOwn(assets, path)) return send(200, ...assets[path]);
  return send(404, 'text/plain', 'Not found');
}).listen(Number(process.env.PORT || 3000), '0.0.0.0');
