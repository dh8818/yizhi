#!/usr/bin/env node
/**
 * 极简静态服务器：把 web-demo/ 跑起来（零依赖）。
 *
 * 用法：node scripts/serve-web.js [端口]
 * 默认 8090，监听 0.0.0.0，所以同一局域网内的手机也能打开 http://<电脑IP>:8090/
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'web-demo');
const PORT = Number(process.argv[2] || process.env.PORT || 8090);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);

  // 防目录穿越
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`衣知网页演示：http://127.0.0.1:${PORT}/`);
  console.log('同一局域网手机可用 http://<电脑IP>:' + PORT + '/');
});
