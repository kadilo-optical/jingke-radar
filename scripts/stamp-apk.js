// 给 www 里的 APK 生成一份「带版本号」的副本，例如 jingke-radar-1.4.12.apk。
//
// 为什么需要它：
// 1) 固定文件名 jingke-radar.apk 的下载链接会被浏览器 / 手机下载器 / 中间代理长期缓存，
//    导致「明明发了新版本，用户下到的还是旧包」；
// 2) 版本化文件名（1.4.12）天然不会命中旧缓存，也方便用户自己核对下到的是哪一版；
// 3) 发布目录里同时保留固定名，老链接继续可用，不会打断已有升级路径。
//
// 用法：先把新 APK 覆盖到 www/jingke-radar.apk，再执行 node scripts/stamp-apk.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const SRC = path.join(WWW, 'jingke-radar.apk');

if (!fs.existsSync(SRC)) {
  console.error('[apk] 找不到 www/jingke-radar.apk，先把构建好的 APK 放进去');
  process.exit(1);
}

const ver = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(ver || '')) {
  console.error('[apk] version.json 里的 version 格式不对:', ver);
  process.exit(1);
}

const buf = fs.readFileSync(SRC);
// APK 是 zip，尾部有 EOCD 签名（PK\x05\x06）。截断的下载会丢掉它，这里先自检，
// 避免把坏包发布出去——用户装到一半报「解析包出错」很难查。
if (buf.length < 1024 || buf.indexOf(Buffer.from('504b0506', 'hex'), buf.length - 65558) === -1) {
  console.error('[apk] 文件不完整（找不到 zip 结束标记），拒绝发布');
  process.exit(1);
}

const md5 = crypto.createHash('md5').update(buf).digest('hex');
const dest = path.join(WWW, `jingke-radar-${ver}.apk`);
fs.copyFileSync(SRC, dest);

console.log(`[apk] v${ver}  ${buf.length} 字节  md5=${md5}`);
console.log(`[apk] 已生成 ${path.basename(dest)}（固定名 jingke-radar.apk 保留兼容）`);
