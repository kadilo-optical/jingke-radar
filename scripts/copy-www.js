// 把网页资源同步到 Capacitor 的 www 目录。
// 只拷贝运行所需的最小集合：入口页 + 云端公开配置。
// 不拷贝 .workbuddy / .tmp / 已收录名单 / 任何含业务数据的文件。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const FILES = ['index.html', 'public-config.js'];

fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW, { recursive: true });

for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) {
    console.error(`[sync] 缺少文件: ${f}`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(WWW, f));
  const kb = (fs.statSync(src).size / 1024).toFixed(1);
  console.log(`[sync] ${f}  ${kb} KB`);
}

console.log(`[sync] 完成 → ${WWW}`);
