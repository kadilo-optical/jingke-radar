// 把网页资源同步到 Capacitor 的 www 目录。
// 同时把 version.json 里的版本号注入 index.html，保证"App内版本号"与"线上version.json"永远一致。
// 只拷贝运行所需的最小集合，不拷贝 .workbuddy / .tmp / 已收录名单 / 任何含业务数据的文件。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const FILES = ['index.html', 'public-config.js', 'sdk.js'];

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
