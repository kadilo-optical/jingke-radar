// 把网页资源同步到 Capacitor 的 www 目录。
// 同时把 version.json 里的版本号注入 index.html，保证"App内版本号"与"线上version.json"永远一致。
// 只拷贝运行所需的最小集合，不拷贝 .workbuddy / .tmp / 已收录名单 / 任何含业务数据的文件。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const FILES = ['index.html', 'public-config.js', 'sdk.js'];
// 网页版发布升级为 Node 服务（静态页 + /api/addr-search 检索接口一体），
// 这三个文件会一起拷进 www/，发布平台检测到 package.json 就用 node 启动
const SITE_FILES = ['server.js', 'addr-search.js', 'package.json'];
const SITE_DIR = path.join(ROOT, 'site');
const verFile = path.join(ROOT, 'version.json');
if (!fs.existsSync(verFile)) {
  console.error('[sync] 缺少 version.json');
  process.exit(1);
}
const ver = JSON.parse(fs.readFileSync(verFile, 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(ver || '')) {
  console.error(`[sync] version.json 的 version 格式不对: ${ver}`);
  process.exit(1);
}

fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW, { recursive: true });

for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) {
    console.error(`[sync] 缺少文件: ${f}`);
    process.exit(1);
  }
  if (f === 'index.html') {
    let html = fs.readFileSync(src, 'utf8');
    // 先确认源文件里确实有这个常量（不能靠"替换前后是否相同"判断，
    // 因为版本号本来就是同一个值时，替换结果与原文完全一致）
    if (!/const APP_VERSION = '[^']*';/.test(html)) {
      console.error('[sync] index.html 里没找到 APP_VERSION 常量，版本号注入失败');
      process.exit(1);
    }
    html = html.replace(/const APP_VERSION = '[^']*';/, `const APP_VERSION = '${ver}';`);
    fs.writeFileSync(path.join(WWW, f), html, 'utf8');
    console.log(`[sync] ${f}  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB  (APP_VERSION=${ver})`);
  } else {
    fs.copyFileSync(src, path.join(WWW, f));
    console.log(`[sync] ${f}  ${(fs.statSync(src).size / 1024).toFixed(1)} KB`);
  }
}

console.log(`[sync] 完成 → ${WWW}`);

// 服务端部署文件（见 site/ 目录说明）
for (const f of SITE_FILES) {
  const src = path.join(SITE_DIR, f);
  if (!fs.existsSync(src)) {
    console.error(`[sync] 缺少服务端文件: ${f}`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(WWW, f));
  console.log(`[sync] server/${f}  ${(fs.statSync(src).size / 1024).toFixed(1)} KB`);
}

// 最后一步：把 sdk.js 内联进 www/index.html，让 App 里的页面成为单文件自包含版本。
// 这样 WebView 就算文件路径解析异常、或者完全离线，也不会因为拿不到 sdk.js 而白屏。
const { execFileSync } = require('child_process');
try {
  execFileSync(process.execPath, [path.join(__dirname, 'inline-sdk.js')], { stdio: 'inherit' });
} catch (e) {
  console.error('[sync] SDK 内联失败:', e.message);
  process.exit(1);
}

// 再内联地址检索引擎（App 内经 CapacitorHttp 直抓搜索引擎，不依赖任何服务器）
try {
  execFileSync(process.execPath, [path.join(__dirname, 'inline-addr-search.js')], { stdio: 'inherit' });
} catch (e) {
  console.error('[sync] 检索引擎内联失败:', e.message);
  process.exit(1);
}
