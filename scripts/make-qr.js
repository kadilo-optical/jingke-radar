// 生成访问二维码（纯 Node 生成 PNG，不依赖第三方库，离线也能跑）
// 使用 ISO/IEC 18004 二维码编码，字节模式，纠错等级 M，版本自适应。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TEXT = 'https://glasses-radar.app.workbuddy.host/?sharecode=ABA2SVUO5X';

/* ---------- 二维码编码核心 ---------- */
const ECC = { L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
              M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28] };
const NUM_BLOCKS = {
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49]
};

function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

// GF(256) 运算
const EXP = new Array(512), LOG = new Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

function rsDivisor(degree) {
  let result = new Array(degree).fill(0); result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) { result[j] = gmul(result[j], root); if (j + 1 < degree) result[j] ^= result[j + 1]; }
    root = gmul(root, 2);
  }
  return result;
}
function rsRemainder(data, divisor) {
  let result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gmul(divisor[i], factor);
  }
  return result;
}

function rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver, ecl) {
  return Math.floor(rawDataModules(ver) / 8) - ECC[ecl][ver] * NUM_BLOCKS[ecl][ver];
}

function encode(text) {
  const bytes = Buffer.from(text, 'utf8');
  const ecl = 'M';
  // 选版本
  let ver = 1;
  for (; ver <= 40; ver++) {
    const cap = dataCodewords(ver, ecl) * 8;
    const ccBits = ver < 10 ? 8 : 16;
    if (4 + ccBits + bytes.length * 8 <= cap) break;
  }
  if (ver > 40) throw new Error('内容过长');

  // 数据位流
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(4, 4);                            // 字节模式
  push(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacity = dataCodewords(ver, ecl) * 8;
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const padBytes = [0xEC, 0x11];
  let padIdx = 0;
  while (bits.length < capacity) { push(padBytes[padIdx++ % 2], 8); }

  // 转 codewords
  const dataCw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    dataCw.push(v);
  }

  // 分块 + RS
  const numBlocks = NUM_BLOCKS[ecl][ver];
  const eccLen = ECC[ecl][ver];
  const rawCw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - rawCw % numBlocks;
  const shortLen = Math.floor(rawCw / numBlocks);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortLen - eccLen + (i < numShort ? 0 : 1);
    const dat = dataCw.slice(k, k + datLen); k += datLen;
    const ecc = rsRemainder(dat, div);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  // 交错
  const maxLen = blocks[0].length;
  const finalCw = [];
  for (let i = 0; i < maxLen; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortLen - eccLen || j >= numShort) finalCw.push(blocks[j][i]);
    }
  }

  return { ver, ecl, codewords: finalCw };
}

/* ---------- 矩阵构建 ---------- */
function buildMatrix(ver, ecl, codewords) {
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { if (x >= 0 && y >= 0 && x < size && y < size) { modules[y][x] = dark; isFn[y][x] = true; } };

  // 时序图形
  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }

  // 定位图形
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy)), xx = cx + dx, yy = cy + dy;
      if (xx >= 0 && yy >= 0 && xx < size && yy < size) setFn(xx, yy, dist !== 2 && dist !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

  // 对齐图形
  const alignPos = [];
  if (ver > 1) {
    const num = Math.floor(ver / 7) + 2;
    const step = Math.floor((ver * 8 + num * 3 + 5) / (num * 4 - 4)) * 2;
    alignPos[0] = 6;
    for (let i = num - 1, pos = size - 7; i >= 1; i--, pos -= step) alignPos[i] = pos;
    for (let i = 0; i < num; i++) for (let j = 0; j < num; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === num - 1) || (i === num - 1 && j === 0)) continue;
      const cx = alignPos[i], cy = alignPos[j];
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
        setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  // 留白（格式信息区域先占位）
  const drawFormat = (mask) => {
    const data = (ecl === 'M' ? 0 : 0) << 3 | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bitsVal = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, getBit(bitsVal, i));
    setFn(8, 7, getBit(bitsVal, 6)); setFn(8, 8, getBit(bitsVal, 7)); setFn(7, 8, getBit(bitsVal, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(bitsVal, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(bitsVal, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(bitsVal, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);

  // 版本信息（v7+）
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bitsVal = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bitsVal, i);
      const a = size - 11 + i % 3, b = Math.floor(i / 3);
      setFn(a, b, bit); setFn(b, a, bit);
    }
  }

  // 放置数据
  let idx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
        if (!isFn[y][x] && idx < codewords.length * 8) {
          modules[y][x] = getBit(codewords[idx >>> 3], 7 - (idx & 7));
          idx++;
        }
      }
    }
  }

  // 掩码选择
  const maskFns = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => x * y % 2 + x * y % 3 === 0,
    (x, y) => (x * y % 2 + x * y % 3) % 2 === 0,
    (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
  ];
  let bestMask = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    const test = modules.map(r => r.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
      if (!isFn[y][x] && maskFns[m](x, y)) test[y][x] = !test[y][x];
    const s = penalty(test, size);
    if (s < bestScore) { bestScore = s; bestMask = m; }
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
    if (!isFn[y][x] && maskFns[bestMask](x, y)) modules[y][x] = !modules[y][x];

  // 重画格式信息（带正确掩码）
  for (let i = 0; i <= 5; i++) setFn(8, i, false);
  drawFormat(bestMask);

  return modules;
}

function penalty(m, size) {
  let p = 0;
  // 规则1：连续同色
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (m[y][x] === m[y][x - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
      else run = 1;
    }
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (m[y][x] === m[y - 1][x]) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
      else run = 1;
    }
  }
  // 规则2：2x2 同色
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
  }
  // 规则4：黑白比例
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m[y][x]) dark++;
  const total = size * size;
  const ratio = Math.abs(dark * 100 / total - 50);
  p += Math.floor(ratio / 5) * 10;
  return p;
}

/* ---------- 输出 PNG ---------- */
function writePNG(modules, file, scale = 10, quiet = 4) {
  const size = modules.length;
  const dim = (size + quiet * 2) * scale;
  const raw = Buffer.alloc((dim * 3 + 1) * dim);
  let o = 0;
  for (let y = 0; y < dim; y++) {
    raw[o++] = 0; // filter type 0
    const my = Math.floor(y / scale) - quiet;
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - quiet;
      let dark = false;
      if (mx >= 0 && my >= 0 && mx < size && my < size) dark = modules[my][mx];
      const v = dark ? 0 : 255;
      raw[o++] = v; raw[o++] = v; raw[o++] = v;
    }
  }
  const chunks = [];
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0); ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return dim;
}

/* ---------- 执行 ---------- */
const { ver, ecl, codewords } = encode(TEXT);
const modules = buildMatrix(ver, ecl, codewords);
const out = path.resolve(__dirname, '..', '访问二维码.png');
const dim = writePNG(modules, out, 10, 4);
console.log(`二维码生成完成`);
console.log(`  内容: ${TEXT}`);
console.log(`  版本: ${ver} (${modules.length}x${modules.length} 模块)  纠错: ${ecl}`);
console.log(`  尺寸: ${dim}x${dim} px`);
console.log(`  文件: ${out}`);

// 终端里也打印一份，方便肉眼校对
const pad = 2;
for (let y = -pad; y < modules.length + pad; y++) {
  let line = '';
  for (let x = -pad; x < modules.length + pad; x++) {
    const dark = y >= 0 && x >= 0 && y < modules.length && x < modules.length && modules[y][x];
    line += dark ? '██' : '  ';
  }
  console.log(line);
}
