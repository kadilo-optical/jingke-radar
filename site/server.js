/* 镜客雷达发布服务（网页版）
 * 作用：把原来的纯静态发布升级为「静态页 + 检索 API」一体服务。
 * 之前网页版每次「按地址找公司」都失败，因为发布站是静态的，
 * 前端 fetch('/api/addr-search') 打到 404 → 永远显示"没搜到"。
 * 现在这个服务同进程提供两者，域名和链接保持不变。
 *
 * 启动：node server.js（平台注入 PORT 环境变量）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { runAddressSearch } = require('./addr-search');

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname; // 部署时与静态文件同目录（www/）

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.apk': 'application/vnd.android.package-archive',
  '.woff2': 'font/woff2',
};

function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({
    'Content-Type': type || 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  }, extra || {}));
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);

  if (req.method === 'OPTIONS') { send(res, 204, ''); return; }

  /* ---- 检索 API（网页版的核心：以前这接口根本不存在） ---- */
  if (p === '/api/addr-search' && req.method === 'POST') {
    const bufs = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { aborted = true; send(res, 413, JSON.stringify({ error: '请求体过大' })); req.destroy(); }
      else bufs.push(c);
    });
    req.on('end', async () => {
      if (aborted) return;
      let area = '', geo = null;
      try {
        const body = JSON.parse(Buffer.concat(bufs).toString('utf8') || '{}');
        area = String(body.area || '').slice(0, 120);
        geo = body.geo && typeof body.geo === 'object' ? body.geo : null;
      } catch (_) { send(res, 400, JSON.stringify({ error: '请求格式错误' })); return; }
      if (!area && !(geo && (geo.city || geo.county || geo.area))) {
        send(res, 400, JSON.stringify({ error: '缺少检索地址' }));
        return;
      }
      const t0 = Date.now();
      try {
        // 检索通常 15~60 秒；给 100 秒硬上限，避免把平台的代理连接拖死
        const r = await Promise.race([
          runAddressSearch(area, geo ? { geo } : undefined),
          new Promise((_, rej) => setTimeout(() => rej(new Error('检索超时')), 100000)),
        ]);
        console.log(`[addr-search] ${area} → total=${r.total} raw=${r.rawTotal} blocked=${r.blocked} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        send(res, 200, JSON.stringify(r));
      } catch (e) {
        console.error('[addr-search] FAIL', area, e.message);
        send(res, 200, JSON.stringify({
          area, total: 0, results: [], dropped: [], stats: {},
          blocked: true, searchedAt: new Date().toISOString(),
          blockHint: '检索服务异常：' + (e.message || '未知错误'),
        }));
      }
    });
    req.on('error', () => {});
    return;
  }

  if (p === '/health') { send(res, 200, JSON.stringify({ ok: true, ts: Date.now() })); return; }

  /* ---- 静态文件 ---- */
  let fp = p === '/' ? '/index.html' : p;
  const f = path.join(ROOT, fp);
  if (!f.startsWith(ROOT)) { send(res, 403, 'forbidden', 'text/plain'); return; }
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) { send(res, 404, '404 ' + p, 'text/plain'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': /\.apk$/.test(f) ? 'no-store' : 'no-cache',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(f).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('glasses-radar server on :' + PORT));
