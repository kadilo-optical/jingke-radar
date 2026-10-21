/* 按地址检索公司 — 真实联网检索服务
 *
 * 设计原则（重要）：
 *   1. 数据必须真的来自公网页面，绝不由模型凭空生成公司名。
 *   2. 模型只做"从网页文字里抽取结构化字段"，抽取结果还要回到原文里做二次校验，
 *      抽不到的字段一律留空，宁缺毋滥。
 *
 * 流程：地址 → 生成多轮检索词 → 并发抓必应搜索结果页 → 解析公司全称 + 地址 + 电话
 *      → 按公司名聚合证据 → 过滤（非义乌 / 疑似工厂 / 噪声词）→ 输出报告
 */
const https = require('https');
const http = require('http');
const zlib = require('zlib');

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/* ---------------- 网络 ---------------- */
// 会话 cookie 池：神马/夸克首次请求通常只回一个 1KB 的验证页并下发 cookie，
// 带上 cookie 重放才拿到真正的结果页。这里按 host 持久化 cookie。
const COOKIE_JAR = new Map();

function cookieHeader(host) {
  const arr = COOKIE_JAR.get(host);
  return arr && arr.length ? arr.join('; ') : '';
}

function absorbCookies(host, setCookie) {
  if (!setCookie) return;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const cur = COOKIE_JAR.get(host) || [];
  list.forEach((c) => {
    const kv = String(c).split(';')[0].trim();
    if (!kv || !kv.includes('=')) return;
    const key = kv.split('=')[0];
    const idx = cur.findIndex((x) => x.split('=')[0] === key);
    if (idx >= 0) cur[idx] = kv; else cur.push(kv);
  });
  COOKIE_JAR.set(host, cur);
}

function request(url, ua, timeout = 12000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const headers = {
      'User-Agent': ua || UA_MOBILE,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'gzip,deflate',
      'Cache-Control': 'no-cache',
      'Upgrade-Insecure-Requests': '1',
    };
    const ck = cookieHeader(u.hostname);
    if (ck) headers.Cookie = ck;

    const req = lib.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers }, (res) => {
      absorbCookies(u.hostname, res.headers['set-cookie']);
      const bufs = [];
      res.on('data', (c) => bufs.push(c));
      res.on('end', () => {
        let b = Buffer.concat(bufs);
        try {
          const enc = res.headers['content-encoding'];
          if (enc === 'gzip') b = zlib.gunzipSync(b);
          else if (enc === 'deflate') b = zlib.inflateSync(b);
        } catch (_) { /* 解压失败就用原始内容 */ }
        resolve({ status: res.statusCode, body: b.toString('utf8') });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function htmlToText(h) {
  return String(h || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&ensp;|&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------------- 地域上下文（支持全国任意省市县） ----------------
   早期版本把"义乌"写死在正则和检索词里，导致：
     1) 只能搜义乌，换任何地址都被强制加"义乌"前缀；
     2) 结果过滤 /^义乌/ 把外地公司全丢掉；
     3) 几个高频公司页面反复命中，无论搜哪儿都出现同一批。
   这里把地域抽象成 GEO 上下文，由调用方按「省/市/县 + 区域」传入，
   所有正则、检索词、片区判定都从 GEO 派生，不再有硬编码地名。 */
const PROVINCE_SUFFIX = /(省|自治区|特别行政区)$/;
const CITY_SUFFIX = /(市|自治州|地区|盟)$/;
const COUNTY_SUFFIX = /(区|县|市|旗|区)$/;

/* 从一段自由文本里猜出 省/市/县/区域。
   做法：按「省 → 市 → 区县」顺序从字符串**开头**逐段剥掉，
   剥不动的部分就是街道/园区/门牌（区域）。
   这样不会出现"浙江省义乌市"被整体当成区县，也不会把"义乌市"的市误认成地级市。 */
function guessGeo(text) {
  const raw = String(text || '').trim();
  const geo = { province: '', city: '', county: '', area: raw };
  if (!raw) return geo;

  let rest = raw;

  // ① 省（开头位置才认，避免把区县里的字误当省）
  const pm = rest.match(/^([\u4e00-\u9fa5]{2,10}?(?:省|自治区|特别行政区))/);
  if (pm) { geo.province = pm[1]; rest = rest.slice(pm[1].length).trim(); }

  // ② 市：连续的"XX市"最多取两个，倒数第二个是地级市、最后一个是县级市
  const cityHits = [];
  let m;
  const cityRe = /^([\u4e00-\u9fa5]{2,8}?市)/;
  while ((m = rest.match(cityRe))) {
    cityHits.push(m[1]);
    rest = rest.slice(m[1].length).trim();
    if (cityHits.length >= 2) break;
  }
  if (cityHits.length === 2) {
    geo.city = cityHits[0];          // 地级市
    geo.county = cityHits[1];        // 县级市
  } else if (cityHits.length === 1) {
    geo.city = cityHits[0];
  }

  // ③ 区/县：紧跟在市后面再剥一层
  const cm = rest.match(/^([\u4e00-\u9fa5]{2,8}?(?:区|县|旗))/);
  if (cm) {
    if (geo.county) {
      // 已经有县级市了，再出现"区"说明前面那个是地级市本身
      geo.city = geo.county;
      geo.county = cm[1];
    } else {
      geo.county = cm[1];
    }
    rest = rest.slice(cm[1].length).trim();
  }

  geo.area = rest.replace(/^[\s,，、·]+|[\s,，、·]+$/g, '') || '';
  return geo;
}

/* 把 省/市/县/区域 拼成检索用的地名串（由精确到宽松） */
function geoStrings(geo) {
  const { province, city, county, area } = geo || {};
  const out = { full: '', countyWide: '', cityWide: '', provinceWide: '' };

  const parts = [];
  if (city) parts.push(city);
  else if (province) parts.push(province);
  if (county && county !== city) parts.push(county);
  if (area && area !== county && area !== city) parts.push(area);
  out.full = parts.join(' ').trim();

  const cp = [];
  if (city) cp.push(city);
  if (county && county !== city) cp.push(county);
  out.countyWide = cp.join(' ') || out.full;

  out.cityWide = city || (province + (county || '')).trim();
  out.provinceWide = province || city || '';
  return out;
}

/* 地域"身份词"：公司名/地址里必须出现其中之一，才算落在本地（替代原来的 /^义乌/） */
function regionIdentityTokens(geo) {
  const { city, county, area } = geo || {};
  const t = new Set();
  [city, county].filter(Boolean).forEach((x) => {
    t.add(x);
    // "义乌市" → "义乌"，"杭州市" → "杭州"，用于匹配省略"市"的写法
    t.add(x.replace(/(市|区|县|省)$/, ''));
  });
  // 只给了"义乌""丹阳"这种不带后缀的地名时，就用它本身当身份词
  if (!t.size && area) {
    const a = String(area).trim();
    if (a.length >= 2 && a.length <= 8) t.add(a);
  }
  return [...t].filter((x) => x && x.length >= 2);
}

/* 地址规范化：留下真正能定位的词，去掉"附近/周边/一带"这类对检索无用的词 */
function normalizeArea(area) {
  return String(area || '')
    .replace(/[（(][^)）]*[)）]/g, ' ')
    .replace(/附近|周边|一带|区域|范围|这块|这边|那边/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------------- 检索词生成 ---------------- */
const CATEGORY_WORDS = ['眼镜', '太阳镜', '墨镜', '老花镜', '镜架', '光学眼镜', '眼镜配件'];

/* 分三级生成检索词：具体区域 → 区县全境 → 全市（还不够再放开到全省）
   搜索引擎对长串组合词命中很差，必须逐级放宽，否则会一条都搜不到。
   geo 可以是字符串（自动识别）或 {province,city,county,area} */
function buildQueryTiers(area, geoIn) {
  const geo = geoIn || (typeof area === 'object' ? area : guessGeo(normalizeArea(area)));
  const g = geoStrings(geo);

  // 区域级短词：只保留最有辨识度的 1~2 段
  const tokens = g.full.split(/\s+/).filter(Boolean);
  const shortArea = tokens.length > 2 ? tokens.slice(0, 2).join(' ') : g.full;

  const cats = ['眼镜有限公司', '太阳镜 贸易有限公司', '老花镜 墨镜 商贸有限公司'];
  const mk = (prefix, tierName) => ({ tier: tierName, queries: cats.map((c) => `${prefix} ${c}`.trim()) });

  const tiers = [mk(g.full || g.cityWide, '区域')];
  if (g.countyWide && g.countyWide !== g.full) tiers.push(mk(g.countyWide, '区县'));
  if (g.cityWide && g.cityWide !== g.countyWide) tiers.push(mk(g.cityWide, '全市'));
  if (g.provinceWide && g.provinceWide !== g.cityWide) tiers.push(mk(g.provinceWide, '全省'));

  return tiers
    .map((t) => ({ tier: t.tier, queries: [...new Set(t.queries)] }))
    .filter((t, i, arr) => i === 0 || t.queries.join('|') !== arr[i - 1].queries.join('|'));
}

function buildQueries(area, geoIn) {
  const out = [];
  buildQueryTiers(area, geoIn).forEach((t) => t.queries.forEach((q) => out.push(q)));
  return [...new Set(out)];
}

/* ---------------- 结果页解析 ---------------- */
// 结果页里常出现的"修饰前缀"，必须剥掉，否则会把"企查查为您提供义乌市XX"当成公司名
const NAME_PREFIX_NOISE = /^(阿里巴巴|企查查|天眼查|爱企查|百度爱企查|启信宝|顺企网|黄页88|马可波罗|搜了网|中国供应商|世界工厂网|慧聪网|八方资源网|一呼百应|sitemap|首页|为您提供|提供|查看|点击|更多|主营|关于|联系|推荐)/;

function cleanName(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  // 剥前缀：从第一个"带行政区划的公司名"位置开始截（不再只认义乌）
  const idx = s.search(/[\u4e00-\u9fa5]{2,12}(?:省|市|区|县)/);
  if (idx > 0) s = s.slice(idx);
  s = s.replace(NAME_PREFIX_NOISE, '');
  s = s.replace(/^[^\u4e00-\u9fa5]+/, '');
  s = s.replace(/[，,。；;：:、\s]+$/, '');
  // 必须以"有限公司/有限责任公司"结尾
  if (!/(有限公司|有限责任公司)$/.test(s)) return '';
  if (s.length > 30) return '';
  // 剥掉行政区划前缀后必须还有实际字号
  const core = s
    .replace(/^[\u4e00-\u9fa5]{2,8}?(?:省|自治区)/, '')
    .replace(/^[\u4e00-\u9fa5]{2,8}市/, '')
    .replace(/^[\u4e00-\u9fa5]{2,8}(?:区|县)/, '')
    .replace(/(有限公司|有限责任公司)$/, '');
  if (core.length < 2) return '';
  // 纯泛词（贸易/商贸/电子商务…）不算有效字号
  if (/^(贸易|商贸|电子商务|科技|实业|供应链|进出口|百货)+$/.test(core)) return '';
  return s;
}

/* 公司名：任意行政区划前缀 + 字号 + 有限公司
   （原先是 /义乌[市]?/ 写死，导致外地公司一律抽不出来） */
const NAME_RE = /[\u4e00-\u9fa5]{2,12}(?:有限公司|有限责任公司)/g;

// 带行政区划前缀的标准地址（通用化：不再要求"义乌"开头）
const ADDR_RE = /[\u4e00-\u9fa5]{2,12}(?:省|市|区|县)[\u4e00-\u9fa5A-Za-z0-9（）()]{0,14}(?:路|街|道|大道|小区|园区|市场|广场|大厦|商厦|商城|城|村|镇)[\u4e00-\u9fa5A-Za-z0-9（）()\-]{0,30}?(?:号|栋|幢|楼|室|层|单元|区)/g;
// 摘要里常省略行政区划，直接从街道写起（如"后宅街道神州路308号上洪电商园5楼"）
const ADDR_RE_BARE = /[\u4e00-\u9fa5]{2,8}(?:街道|镇|路|街|道|小区|园区|市场|商城)[\u4e00-\u9fa5A-Za-z0-9（）()\-]{0,26}?(?:号|栋|幢|楼|室|层|单元)[\u4e00-\u9fa5A-Za-z0-9（）()\-]{0,20}/g;

const FACTORY_WORDS = /制造|生产加工|工厂|车间|产线|模具加工|自产自销|工厂店|实业有限公司/;

/* 地址清洗：结果页会把"义乌市北苑街道社区卫生服务中心"这种非地址实体误判成地址 */
const ADDR_BLACKLIST = /服务中心|办事处|管理局|派出所|委员会|人民政府|学校|幼儿园|医院|银行|营业厅|加油站|停车场|公交站|地铁站|菜市场|超市|药店|酒店|宾馆|餐厅|景区|公园|广场舞/;

function pickAddr(text) {
  const hits = [...(text.match(ADDR_RE) || []), ...(text.match(ADDR_RE_BARE) || [])];
  const clean = hits
    .map((x) => x.split(/联系|电话|手机|主营|经营范围|法定|邮编/)[0].trim())
    .map((x) => x.replace(/[，,。；;、]$/, '').trim())
    .filter((x) => x.length >= 8 && x.length <= 56)
    .filter((x) => /号|栋|幢|楼|室|层|单元/.test(x))     // 必须有门牌级信息
    .filter((x) => !ADDR_BLACKLIST.test(x));
  if (!clean.length) return '';
  const freq = new Map();
  clean.forEach((a) => freq.set(a, (freq.get(a) || 0) + 1));
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
}

function pickTels(text) {
  const hits = text.match(/1[3-9]\d{9}|0579[-\s]?\d{7,8}|400[-\s]?\d{3}[-\s]?\d{4}/g) || [];
  return [...new Set(hits.map((x) => x.replace(/\s+/g, '-')))].slice(0, 3);
}

function pickPlatforms(text) {
  const map = {
    '1688': /1688/i, '阿里国际站': /阿里国际站|alibaba\.com|国际站/i, 'Temu': /temu/i,
    'Shein': /shein|希音/i, 'TikTok': /tiktok|抖音/i, '亚马逊': /亚马逊|amazon/i,
    '义乌购': /义乌购|yiwugo/i, 'Chinagoods': /chinagoods/i, '拼多多': /拼多多/i,
    '淘宝/天猫': /淘宝|天猫|taobao|tmall/i, '速卖通': /速卖通|aliexpress/i,
  };
  return Object.entries(map).filter(([, re]) => re.test(text)).map(([k]) => k);
}

const SCALE_PATTERNS = [
  [/SKU\s*[≥>]?\s*(\d{2,5})|(\d{2,5})\s*(?:个|款)\s*SKU/i, (m) => `SKU ${m[1] || m[2]}`],
  [/(\d{1,3})\s*[-~至]\s*(\d{2,4})\s*人/, (m) => `员工 ${m[1]}-${m[2]} 人`],
  [/员工[规模]*\s*(\d{1,5})\s*人/, (m) => `员工 ${m[1]} 人`],
  [/(\d[\d,]{2,})\s*(?:条|个)\s*(?:评价|评论)/, (m) => `评价 ${m[1]}`],
  [/(\d{4,})\s*粉丝/, (m) => `粉丝 ${m[1]}`],
  [/(\d{1,2})\s*年(?:会员|经营|老店|诚信通)/, (m) => `经营 ${m[1]} 年`],
  [/年(?:销售额|出口额|产值)\s*(\d+(?:\.\d+)?)\s*(万|亿)/, (m) => `年销售额 ${m[1]}${m[2]}`],
];

function pickScale(text) {
  const out = [];
  for (const [re, fmt] of SCALE_PATTERNS) {
    const m = text.match(re);
    if (m) out.push(fmt(m));
    if (out.length >= 3) break;
  }
  return out;
}

/* 检索源（实测 2026-10）：
   - 360 搜索 m.so.com：稳定、可直接抓，摘要里常带地址/电话 → 主力
   - 神马/夸克（阿里系）：会弹 x5secdata 滑块验证码，无法用纯请求绕过 → 只做兜底
   - 必应：机房 IP 有限流，可能返回无关结果 → 末位兜底 */
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
const SEARCH_SOURCES = [
  // 搜狗 wap：2026-10 实测国内机房 IP 仍可直出结果，摘要含公司名/地址/电话，列为首选
  { name: '搜狗', url: (q) => 'https://wap.sogou.com/web/searchList.jsp?keyword=' + encodeURIComponent(q), ua: UA_MOBILE },
  { name: '360', url: (q) => 'https://m.so.com/s?q=' + encodeURIComponent(q), ua: UA_MOBILE },
  { name: '必应', url: (q) => 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&count=30', ua: UA_MOBILE },
  { name: '360pc', url: (q) => 'https://www.so.com/s?q=' + encodeURIComponent(q), ua: UA_DESKTOP },
  { name: '神马', url: (q) => 'https://so.m.sm.cn/s?q=' + encodeURIComponent(q), ua: UA_MOBILE },
];

/* 抓一轮搜索结果：按源顺序尝试，拿到足够多的公司名就停。
   每个源最多试 2 次（第 1 次常被下发 cookie 挡回验证页，第 2 次带 cookie 就正常）。 */
async function searchOnce(query, opts = {}) {
  const minNames = opts.minNames || 2;
  const tries = [];
  for (const src of SEARCH_SOURCES) {
    let url;
    try { url = src.url(query); } catch (_) { continue; }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await request(url, src.ua, 14000);
        const html = res.body || '';
        const text = htmlToText(html);
        const names = new Set((text.match(NAME_RE) || []).map(cleanName).filter(Boolean));
        tries.push(src.name + (attempt ? '#' : ':') + (res.status === 200 ? names.size : 'HTTP' + res.status));
        if (res.status === 200 && names.size >= minNames) {
          return { query, ok: true, text, html, via: src.name };
        }
      } catch (e) {
        tries.push(src.name + ':' + (e.code || 'ERR'));
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, attempt === 0 ? 400 : 700));
    }
  }
  return { query, ok: false, err: tries.join(' / '), text: '', html: '' };
}

/* 从搜索结果页 HTML 里按"结果条目"切块。
   360 / 神马这类页面每条结果都在 <li> 或指定 class 的容器里，
   直接按 </li> 切会把导航、相关搜索也切进来，所以要挑"含义乌 + 含公司全称"的块。 */
function snippetsFromHtml(html) {
  if (!html) return [];
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  let blocks = cleaned.split(/<\/li>|<\/article>|<\/section>/i).filter((b) => b.length > 120);
  let texts = blocks.map((b) => htmlToText(b)).filter((t) => t.length > 40);

  // 抓不到结构化块就退化成整页文字（下面 extractFromText 还能兜）
  if (texts.length < 3) texts = [htmlToText(cleaned)];
  return texts;
}

/* 电话归属：真实结果页里同一个电话会重复出现在多家公司摘要中（导航/推荐位串台）。
   处理规则：同一个号码被 ≥2 家不同公司同时命中，就无法确认归属，统一作废。 */
function resolvePhones(items) {
  const owner = new Map(); // tel -> Set(name)
  items.forEach((it) => {
    (it.tels || []).forEach((t) => {
      if (!owner.has(t)) owner.set(t, new Set());
      owner.get(t).add(it.name);
    });
  });
  const ambiguous = new Set([...owner.entries()].filter(([, names]) => names.size > 1).map(([t]) => t));
  items.forEach((it) => {
    it.ambiguousPhones = (it.tels || []).filter((t) => ambiguous.has(t));
    it.tels = (it.tels || []).filter((t) => !ambiguous.has(t));
  });
  return items;
}

/* 同一家公司在不同页被写成「义乌市X」和「义乌X」时合并成一条
   （行政区划前缀通用化，不再只认义乌） */
function normalizeNameVariants(list) {
  const key = (n) => n
    .replace(/^[\u4e00-\u9fa5]{2,8}?(?:省|自治区)/, '')
    .replace(/^[\u4e00-\u9fa5]{2,8}市/, '')
    .replace(/^[\u4e00-\u9fa5]{2,8}(?:区|县)/, '')
    .replace(/(有限公司|有限责任公司)$/, '');
  const groups = new Map();
  list.forEach((it) => {
    const k = key(it.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  });
  const out = [];
  groups.forEach((arr) => {
    if (arr.length === 1) { out.push(arr[0]); return; }
    // 取名字最长的作为正式名（通常带完整行政区划，更规范）
    const main = arr.slice().sort((a, b) => b.name.length - a.name.length)[0];
    const merged = { ...main };
    arr.forEach((x) => {
      merged.hits = (merged.hits || 1) + (x.hits || 1) - 1;
      merged.queries = [...new Set([...(merged.queries || []), ...(x.queries || [])])];
      merged.addrs = [...new Set([...(merged.addrs || []), ...(x.addrs || [])])];
      if (x.addr && !(merged.addrs || []).includes(x.addr)) merged.addrs.push(x.addr);
      merged.tels = [...new Set([...(merged.tels || []), ...(x.tels || [])])];
      merged.platforms = [...new Set([...(merged.platforms || []), ...(x.platforms || [])])];
      merged.scales = [...new Set([...(merged.scales || []), ...(x.scales || [])])];
      if (!merged.snippet && x.snippet) merged.snippet = x.snippet;
    });
    out.push(merged);
  });
  return out;
}

/* 从一整页文字里抽公司。
   关键：先把文本按"公司名出现位置"切块，每家公司只看自己那一块上下文，
   否则相邻两家公司的地址和电话会互相串。
   target 用于判断"这家公司是否属于本轮目标行业"，不相关直接丢，避免泛贸易公司混进线索库。 */
function extractFromText(text, query, target = '') {
  const matches = [...text.matchAll(NAME_RE)];
  if (!matches.length) return [];

  // 目标行业关键词：从检索词里拆（如"太阳镜 贸易"→ 太阳镜 / 眼镜 / 老花镜…）
  const catWords = ['眼镜', '太阳镜', '墨镜', '老花镜', '镜架', '光学', '视觉', '镜片', '配镜'];
  const wantCat = catWords.filter((w) => target.includes(w));
  const categoryFilter = wantCat.length > 0;

  const seen = new Map();
  matches.forEach((m, i) => {
    const name = cleanName(m[0]);
    if (!name || seen.has(name)) return;
    const at = m.index || 0;
    const nextAt = matches[i + 1] ? (matches[i + 1].index || 0) : text.length;
    // 结果页每条摘要通常 120~350 字，这里给足 600 字且不越到下一家公司
    const snippet = text.slice(at, Math.min(nextAt, at + 600));

    if (categoryFilter) {
      const inName = wantCat.some((w) => name.includes(w));
      const inSnippet = wantCat.some((w) => snippet.includes(w));
      if (!inName && !inSnippet) return;   // 与眼镜无关，直接丢掉
    }

    seen.set(name, {
      name,
      addr: pickAddr(snippet),
      tels: pickTels(snippet),
      platforms: pickPlatforms(snippet),
      scale: pickScale(snippet),
      snippet: snippet.slice(0, 260),
      query,
    });
  });
  return [...seen.values()];
}

/* ---------------- 汇总 & 过滤 ---------------- */
function mergeByName(list) {
  const map = new Map();
  for (const it of list) {
    const key = it.name;
    if (!map.has(key)) {
      map.set(key, { ...it, hits: 1, queries: [it.query], addrs: it.addr ? [it.addr] : [], tels: [...it.tels], platforms: [...it.platforms], scales: [...it.scale] });
      continue;
    }
    const cur = map.get(key);
    cur.hits += 1;
    if (!cur.queries.includes(it.query)) cur.queries.push(it.query);
    if (it.addr && !cur.addrs.includes(it.addr)) cur.addrs.push(it.addr);
    it.tels.forEach((t) => { if (!cur.tels.includes(t)) cur.tels.push(t); });
    it.platforms.forEach((p) => { if (!cur.platforms.includes(p)) cur.platforms.push(p); });
    it.scale.forEach((s) => { if (!cur.scales.includes(s)) cur.scales.push(s); });
    if (!cur.snippet && it.snippet) cur.snippet = it.snippet;
  }
  return [...map.values()];
}

function judge(item, area) {
  const blob = [item.name, ...item.addrs, item.snippet, ...item.scales].join(' ');
  const reasons = [];
  let level = 'B';

  // ① 相关性：公司名必须直接带眼镜品类。
  //    实测：搜索结果页会把同页的其他公司（贸易/日用品/玩具）一起带进来，
  //    如果只看摘要，任何一条含"眼镜"的页面都会把无关公司拖进来，所以这里卡死字号。
  const nameHit = /眼镜|光学|镜片|镜业|配镜|视觉|镜架/.test(item.name);
  const snipHit = /眼镜|太阳镜|墨镜|老花镜|镜架|镜片|偏光|防蓝光|光学/.test(blob);
  let relevant = true;
  if (!nameHit) {
    relevant = false;
    reasons.push('公司字号不含眼镜品类，判定为不相关（多为综合贸易或同页干扰）');
  } else {
    reasons.push('公司字号直接含眼镜品类，行业匹配度高');
  }
  if (nameHit && !snipHit) {
    reasons.push('摘要未提及具体品类，需人工确认主营');
  }

  // ② 纯贸易判定
  const isFactory = FACTORY_WORDS.test(blob);
  if (isFactory) {
    reasons.push('网页描述出现"制造/加工/工厂"字样，疑似工厂主体');
    level = 'C';
  } else if (relevant) {
    reasons.push('未发现工厂/生产加工描述，按纯贸易主体处理');
  }

  // ③ 品类
  if (/太阳镜|墨镜|老花镜|镜架|儿童镜|运动镜|平光|蓝光|偏光/.test(blob)) {
    reasons.push('命中非近视品类（太阳镜/老花镜/镜架等）');
  } else if (relevant) {
    reasons.push('品类未明确，需人工确认是否只做近视镜');
  }

  // ④ 体量
  if (item.scales.length) {
    reasons.push('体量信号：' + item.scales.join('；'));
    if (level === 'B' && !isFactory) level = 'A';
  } else if (relevant) {
    reasons.push('未见硬体量指标，需电话核实');
  }

  // ⑤ 联系方式与地址
  if (item.tels.length) reasons.push('已公开联系电话：' + item.tels.join(' / '));
  if (item.addrs.length) reasons.push('地址：' + item.addrs[0]);

  if (!relevant) level = 'D';

  const confidence = !relevant ? '不相关' : item.hits >= 3 ? '高' : item.hits === 2 ? '中' : '低';
  return { level, reasons, confidence, relevant };
}

function toLeadPayload(item, area, judgeResult) {
  const addr = item.addrs[0] || '';
  return {
    company: item.name,
    shop_name: '',
    boss_name: '',
    phone: item.tels[0] || '',
    platforms: item.platforms.join(' / '),
    revenue_evidence: item.scales.join('；'),
    demand_signal: judgeResult.reasons.slice(0, 2).join('；'),
    area: addr || area,
    note: `按地址检索收录｜来源检索词：${item.queries.join(' ｜ ')}｜网页证据：${item.snippet || '无'}`,
    grade: judgeResult.level,
    source: '按地址检索',
    extra_phones: item.tels.slice(1),
  };
}

/* 从整页搜文字按结构化切块抽取。
   比"从一整条文字流里按公司名切"准得多：地址、电话不会串到别家公司头上。 */
function extractByBlocks(snippets, query, target = '') {
  const out = [];
  const seen = new Set();
  for (const s of snippets) {
    const matches = [...s.matchAll(NAME_RE)];
    if (!matches.length) continue;
    // 一块里若出现多家公司，只用第一家的上下文当证据更保守
    const name = cleanName(matches[0][0]);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      addr: pickAddr(s),
      tels: pickTels(s),
      platforms: pickPlatforms(s),
      scale: pickScale(s),
      snippet: s.slice(0, 260),
      query,
    });
  }
  return out;
}

/* 地址归片：判断这条线索是否真的落在用户指定的区域里 */
function areaMatchScore(item, area, geoIn) {
  const geo = geoIn || (typeof area === 'object' ? area : guessGeo(normalizeArea(area)));
  const base = normalizeArea(geo.area || '');
  const drop = [geo.province, geo.city, geo.county].filter(Boolean);
  let rest = base;
  drop.forEach((d) => { rest = rest.split(d).join(' '); });
  const tokens = rest.split(/\s+/).filter((x) => x.length >= 2);
  const blob = [item.name, ...(item.addrs || []), item.snippet || ''].join(' ');
  if (!tokens.length) return { inArea: true, matched: [] };
  const matched = tokens.filter((t) => blob.includes(t));
  return { inArea: matched.length > 0, matched };
}

/* 第二轮：对已确认的义乌眼镜公司逐个补地址和电话。
   搜索结果页的公司名往往只有标题、没有工商摘要，所以针对每家公司再搜一次「公司名 + 地址电话」，
   仍是真实网页抓取，抓不到就留空。并发有限（同时 4 个），避免被墙限流。 */
async function enrichDetails(results, limit = 10) {
  const targets = results.filter((x) => x.relevant).slice(0, limit);
  const POOL = 4;
  let cursor = 0;

  async function worker() {
    while (cursor < targets.length) {
      const idx = cursor;
      cursor += 1;
      const r = targets[idx];
      const q = `${r.name} 地址 电话`;
      // eslint-disable-next-line no-await-in-loop
      const s = await searchOnce(q, { minNames: 1 });
      if (!s.ok) continue;
      // 只看这家公司自己那块上下文（去掉行政区划前缀再定位，各家写法不一）
      const bare = r.name
        .replace(/^[\u4e00-\u9fa5]{2,8}?(?:省|自治区)/, '')
        .replace(/^[\u4e00-\u9fa5]{2,8}市/, '')
        .replace(/^[\u4e00-\u9fa5]{2,8}(?:区|县)/, '');
      let at = s.text.indexOf(bare);
      if (at < 0) at = s.text.indexOf(r.name);
      const chunk = at >= 0 ? s.text.slice(Math.max(0, at - 40), at + 700) : '';
      if (!chunk) continue;

      const addr = pickAddr(chunk);
      const tels = pickTels(chunk);
      if (addr && !r.addresses.includes(addr)) r.addresses.push(addr);
      tels.forEach((t) => { if (!r.phones.includes(t)) r.phones.push(t); });
      if (!r.evidence && chunk) r.evidence = chunk.slice(0, 240);
      const sc = pickScale(chunk);
      sc.forEach((v) => { if (!r.scales.includes(v)) r.scales.push(v); });
      const pf = pickPlatforms(chunk);
      pf.forEach((v) => { if (!r.platforms.includes(v)) r.platforms.push(v); });
      r.detailChecked = true;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res) => setTimeout(res, 260));
    }
  }

  await Promise.all(Array.from({ length: Math.min(POOL, targets.length) }, () => worker()));

  // 补完之后再按真实数据重算一次地址与电话归属
  targets.forEach((r) => {
    r.address = r.addresses[0] || '';
  });
  return results;
}

/* ---------------- 主入口 ----------------
   area 可以是字符串（自动识别省市区），也可以是 {province,city,county,area} 对象。
   传对象时识别结果更准（选择器选的），传字符串会走 guessGeo 自动识别。 */
async function runAddressSearch(area, opts = {}) {
  // opts.geo：选择器传来的 {province,city,county,area}，优先于自动识别
  const geo = opts.geo
    ? { province: opts.geo.province||'', city: opts.geo.city||'', county: opts.geo.county||'', area: opts.geo.area||'' }
    : ((typeof area === 'object' && area) ? area : guessGeo(normalizeArea(area)));
  const areaLabel = geoStrings(geo).full || geo.area || String(area || '');
  const tiers = buildQueryTiers(area, geo);
  const rounds = [];
  const all = [];

  for (const t of tiers) {
    if (all.length >= 14) break;   // 已经够多了就不再往下放宽
    for (const q of t.queries) {
      // eslint-disable-next-line no-await-in-loop
      const r = await searchOnce(q);
      const row = { tier: t.tier, query: q, ok: r.ok, via: r.via || '', err: r.err || '', found: 0 };
      if (r.ok) {
        // 两条抽取路线都跑：结构化切块 + 纯文字流，结果合并去重
        const blockItems = extractByBlocks(snippetsFromHtml(r.html), q, q);
        const flowItems = extractFromText(r.text, q, q);
        const merged = mergeByName([...blockItems, ...flowItems]);
        row.found = merged.length;
        merged.forEach((x) => all.push({ ...x, tier: t.tier }));
      }
      rounds.push(row);
      await new Promise((res) => setTimeout(res, 200));
    }
  }

  let merged = mergeByName(all);

  // 地域过滤：公司名或地址里必须出现本地的市/区县身份词，
  // 避免别的城市的公司混进来（原来写死 /^义乌/，现在按 geo 派生）
  const idTokens = regionIdentityTokens(geo);
  if (idTokens.length) {
    merged = merged.filter((x) => {
      const blob = [x.name, ...(x.addrs || []), x.snippet || ''].join(' ');
      return idTokens.some((t) => blob.includes(t));
    });
  }
  // 同一家公司的两种写法合并；串台电话作废
  merged = normalizeNameVariants(merged);
  merged = resolvePhones(merged);

  const results = merged.map((it) => {
    const j = judge(it, areaLabel);
    const am = areaMatchScore(it, area, geo);
    return {
      name: it.name,
      address: it.addrs[0] || '',
      addresses: it.addrs,
      phones: it.tels,
      platforms: it.platforms,
      scales: it.scales,
      evidence: it.snippet,
      hits: it.hits,
      tier: it.tier,
      queries: it.queries,
      confidence: j.confidence,
      level: j.level,
      relevant: j.relevant,
      inArea: am.inArea,
      areaMatched: am.matched,
      reasons: j.reasons,
      lead: toLeadPayload(it, areaLabel, j),
    };
  });

  // 第二轮：补地址和电话（只对相关的做，最多 10 家，避免耗时过长）
  if (opts.enrich !== false) {
    await enrichDetails(results, 10);
  }

  // 排序：相关且落在片区内的排前面，其次看等级和命中次数
  const order = { A: 0, B: 1, C: 2, D: 3 };
  results.sort((a, b) => {
    if (a.relevant !== b.relevant) return a.relevant ? -1 : 1;
    if (a.inArea !== b.inArea) return a.inArea ? -1 : 1;
    return (order[a.level] - order[b.level]) || (b.hits - a.hits);
  });

  const roundStats = rounds.map((r) => ({ tier: r.tier, query: r.query, ok: r.ok, via: r.via, err: r.err, found: r.found }));
  const okRounds = roundStats.filter((r) => r.ok).length;
  const related = results.filter((x) => x.relevant);

  // 判定「被搜索引擎拦截」：一轮都没拿到结果页，且错误里出现 302/验证码/超时
  const blocked = okRounds === 0;
  const blockHint = blocked
    ? '本次没能拿到搜索引擎的结果页（多半是当前网络/IP 被风控拦截了：返回 302 验证页或超时）。'
      + '这不是「没有公司」——请先换个网络（切 4G/5G 再试），或过 10 分钟再点一次。'
    : '';

  return {
    area: areaLabel || String(area || ''),
    geo,
    searchedAt: new Date().toISOString(),
    queries: roundStats,
    total: related.length,
    rawTotal: results.length,
    blocked,
    blockHint,
    stats: {
      A: related.filter((x) => x.level === 'A').length,
      B: related.filter((x) => x.level === 'B').length,
      C: related.filter((x) => x.level === 'C').length,
      dropped: results.length - related.length,
      inArea: related.filter((x) => x.inArea).length,
      withPhone: related.filter((x) => x.phones.length).length,
      withAddress: related.filter((x) => x.address).length,
      rounds: roundStats.length,
      okRounds,
    },
    results: related,
    dropped: results.filter((x) => !x.relevant).map((x) => ({ name: x.name, why: x.reasons[0] })),
  };
}

module.exports = {
  runAddressSearch, buildQueries, buildQueryTiers, extractFromText, extractByBlocks,
  cleanName, judge, guessGeo, geoStrings, regionIdentityTokens,
};
