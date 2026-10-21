/* 本地/局域网检索服务
 *
 * 作用：给「按地址找公司」提供真实联网检索接口。
 * 启动：node scripts/search-server.js  （默认端口 8787）
 * 接口：
 *   GET  /              → 返回 index.html（带 sharecode 无关，纯本地）
 *   POST /api/addr-search  { area }  → 返回检索报告 JSON
 *   GET  /health        → { ok: true }
 *
 * 说明：前端在网页版走同源 /api/addr-search；
 * App 内因为 origin 是 https://localhost，没有同源后端，
 * 所以 App 里要显式配置 PUBLIC_CONFIG.searchApi（见 README 里的部署说明）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { runAddressSearch } = require('./addr-search');

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
};

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',           // 方便 App 内跨域调用
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (url.pathname === '/health') return send(res, 200, JSON.stringify({ ok: true }));

  if (url.pathname === '/api/addr-search') {
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ error: 'POST only' }));
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let area = '';
      let geo = null;
      try {
        const body = JSON.parse(raw || '{}');
        area = String(body.area || '').trim();
        if (body.geo && typeof body.geo === 'object') geo = body.geo;
      } catch (_) {}
      // 允许只传 geo（选择器选了省市区但没填区域）
      if (!area && geo) area = String(geo.area || geo.county || geo.city || geo.province || '').trim();
      if (!area) return send(res, 400, JSON.stringify({ error: '缺少 area' }));
      try {
        const t0 = Date.now();
        const r = await runAddressSearch(area, geo ? { geo } : {});
        console.log(`[search] "${area}"${geo ? ' geo=' + JSON.stringify(geo) : ''} → ${r.total} 家（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
        send(res, 200, JSON.stringify(r));
      } catch (e) {
        console.error('[search] 失败', e);
        send(res, 500, JSON.stringify({ error: e.message || '检索失败' }));
      }
    });
    return;
  }

  // 静态文件
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(ROOT, decodeURIComponent(p));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  console.log(`[server] 检索接口 POST /api/addr-search`);
});
