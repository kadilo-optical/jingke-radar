// 把 sdk.js 内联进 index.html，生成"自包含"版本。
// 动机：外部文件引用（相对路径 / 绝对路径 / CDN）在 Android WebView 里都有失败可能，
// 一旦 sdk.js 拿不到，页面就只剩"云端组件没能加载出来"。内联后单文件自包含，零外部依赖。
//
// 用法：node scripts/inline-sdk.js <输入html> <输出html>
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const srcHtml = process.argv[2] || path.join(ROOT, 'index.html');
const outHtml = process.argv[3] || path.join(ROOT, 'www', 'index.html');

let html = fs.readFileSync(srcHtml, 'utf8');
const sdk = fs.readFileSync(path.join(ROOT, 'sdk.js'), 'utf8');

// 安全检查：内联进 <script> 时不能出现会提前闭合标签的序列
if (/<\/script/i.test(sdk) || /<!--/.test(sdk)) {
  console.error('[inline] sdk.js 中含 </script> 或 <!--，不能直接内联');
  process.exit(1);
}

// 替换策略：把"外链 sdk.js + 两段 CDN 兜底"整块换成一个内联 <script>
// 若源文件已经是内联版（没有外链标记），直接原样输出即可（幂等）。
const MARK_START = '<script src="./sdk.js"></script>';
const startIdx = html.indexOf(MARK_START);
if (startIdx < 0) {
  if (/WorkBuddyCloud=\(\(\)=>\{|var WorkBuddyCloud=/.test(html)) {
    fs.writeFileSync(outHtml, html, 'utf8');
    console.log(`[inline] 已是内联版，直接输出 → ${outHtml}  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
    process.exit(0);
  }
  console.error('[inline] 在 HTML 里没找到 sdk.js 的引用标记，也不是内联版');
  process.exit(1);
}
// 找到这之后连续的两段 CDN 兜底脚本块的结束位置
const tail = html.slice(startIdx);
const endMarkerRe = /<script>\s*if\s*\(typeof WorkBuddyCloud === 'undefined'\)\{[\s\S]*?\}\s*<\/script>/g;
let lastEnd = MARK_START.length;
let m;
while ((m = endMarkerRe.exec(tail))) {
  if (m.index > lastEnd + 400) break;   // 只吃掉紧邻的兜底块
  lastEnd = m.index + m[0].length;
}
const blockEnd = startIdx + lastEnd;

const inlined =
  '<!-- 云端 SDK 已内联（' + (sdk.length / 1024).toFixed(1) + 'KB），整页单文件自包含，不依赖任何外部脚本 -->\n' +
  '<script>\n' + sdk + '\n</script>';

html = html.slice(0, startIdx) + inlined + html.slice(blockEnd);

// 注：public-config.js 也内联，彻底去掉外部文件依赖
const cfgTag = '<script src="./public-config.js"></script>';
const cfgIdx = html.indexOf(cfgTag);
if (cfgIdx >= 0) {
  const cfg = fs.readFileSync(path.join(ROOT, 'public-config.js'), 'utf8');
  html = html.slice(0, cfgIdx) + '<script>\n' + cfg + '\n</script>' + html.slice(cfgIdx + cfgTag.length);
}

fs.writeFileSync(outHtml, html, 'utf8');
console.log(`[inline] ${path.basename(srcHtml)} + sdk.js → ${outHtml}  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
