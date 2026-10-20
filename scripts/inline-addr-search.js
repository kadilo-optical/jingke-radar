/* 构建时把 addr-search.js 转成"浏览器版"并内联进 index.html。
 *
 * 转换点：
 * 1. 去掉 require('https'/'http')、module.exports；
 * 2. 把 Node 版 request() 替换成浏览器版：
 *    - App（Capacitor WebView）里走 CapacitorHttp 原生插件，绕过 CORS，可直接抓搜索引擎；
 *    - 万一插件不可用（理论不会），回退 fetch（网页同源场景由 API 服务兜底）。
 * 3. 输出注入到 index.html 的 <!-- INLINE_ADDR_SEARCH --> 标记处。
 *
 * 用法：node scripts/inline-addr-search.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'scripts', 'addr-search.js');
const HTML = path.join(ROOT, 'index.html');
const MARK_BEGIN = '<!-- INLINE_ADDR_SEARCH_BEGIN -->';
const MARK_END = '<!-- INLINE_ADDR_SEARCH_END -->';

const BROWSER_REQUEST = `
/* ---- 浏览器版网络层：App 内用 CapacitorHttp 绕过 CORS，直接抓搜索引擎 ---- */
async function netFetch(url, ua, timeoutMs) {
  const headers = {
    'User-Agent': ua || UA_MOBILE,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  // 1) Capacitor 原生 HTTP（App 内）：无 CORS 限制
  const cap = (typeof window !== 'undefined') && window.Capacitor
    && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
  if (cap && cap.get) {
    try {
      const r = await cap.get({ url, headers, connectTimeout: timeoutMs || 14000, readTimeout: timeoutMs || 14000 });
      // 吸收 set-cookie（神马/夸克是"首访下发 cookie、带 cookie 才给结果"的两段式）
      try {
        let host = '';
        try { host = new URL(url).hostname; } catch (_) {}
        const sc = r.headers && (r.headers['set-cookie'] || r.headers['Set-Cookie']);
        if (host && sc && typeof absorbCookies === 'function') absorbCookies(host, sc);
      } catch (_) {}
      const body = typeof r.data === 'string' ? r.data : String(r.data || '');
      return { status: r.status, body };
    } catch (e) { throw new Error((e && e.message) || 'caphttp failed'); }
  }
  // 2) 普通 fetch：网页版同源场景（本地 API 服务）可用
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 14000) : null;
  try {
    const res = await fetch(url, { headers, signal: ctrl ? ctrl.signal : undefined });
    const body = await res.text();
    return { status: res.status, body };
  } finally { if (timer) clearTimeout(timer); }
}
`;

/* 提取 addr-search.js 的主体（去掉 Node 头尾） */
function toBrowserVersion() {
  let src = fs.readFileSync(SRC, 'utf8');
  // 去掉 Node require 头
  src = src.replace(/const https = require\('https'\);\s*\n\s*const http = require\('http'\);\s*\n\s*const zlib = require\('zlib'\);\s*\n/, '');
  // 去掉 Node 版 request 函数（从 "function request(" 到它结束的 "}" —— 用标记定位更稳）
  const reqStart = src.indexOf('function request(url, ua, timeout = 12000) {');
  if (reqStart >= 0) {
    // 从 reqStart 往后找配对的 "}"（按大括号计数）
    let i = src.indexOf('{', reqStart), depth = 0, end = -1;
    for (; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end > 0) src = src.slice(0, reqStart) + BROWSER_REQUEST + src.slice(end + 1);
  }
  // 去掉 module.exports，调用点同步改名为 netFetch
  src = src.replace(/module\.exports[^;]*;\s*\n?/, '');
  src = src.split('await request(').join('await netFetch(');
  return src.trim();
}

function main() {
  let html = fs.readFileSync(HTML, 'utf8');
  const inner = toBrowserVersion();
  const block = `${MARK_BEGIN}\n<script>\n${inner}\n</script>\n${MARK_END}`;
  const b = html.indexOf(MARK_BEGIN);
  const e = html.indexOf(MARK_END);
  if (b >= 0 && e > b) {
    html = html.slice(0, b) + block + html.slice(e + MARK_END.length);
  } else {
    // 第一次：插到「主脚本」整块之前。
    // 注意：主脚本可能是 <script> + 依赖检查 + const cloud = ... 的组合，
    // 不能锚定 '<script>\nconst cloud ='——那样会把块插进主脚本内部，造成 HTML 注释落在 JS 里。
    const anchorRe = /<script>\s*\/\* =+\s*\r?\n\s*镜客雷达/;
    const am = anchorRe.exec(html);
    let anchor = am ? am.index : -1;
    if (anchor < 0) anchor = html.indexOf('<script>\nconst cloud =');
    if (anchor < 0) { console.error('[inline-search] 找不到插入锚点'); process.exit(1); }
    html = html.slice(0, anchor) + block + '\n\n' + html.slice(anchor);
  }

  // 兜底自检：注入后解析全部 <script> 块，只要有一块语法不合法就报错退出（防止白屏产物）
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const vm = require('vm');
  blocks.forEach((code, i) => {
    try { new vm.Script(code); } catch (err) {
      console.error(`[inline-search] script[${i}] 语法错误：${err.message}`);
      process.exit(1);
    }
  });
  fs.writeFileSync(HTML, html, 'utf8');
  console.log(`[inline-search] 已内联 ${(inner.length / 1024).toFixed(1)}KB 检索引擎 → index.html`);
}

main();
