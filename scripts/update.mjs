// 生活小妙招 · 自动更新程序
// 1) 到 zh.wikihow.com 首页抓取最新指南文章，过滤出生活类标题，进文章页取首段作妙招内容
// 2) 新内容并入 data/tips.json 题库（去重、种子条目永不淘汰）
// 3) 按日期轮换题库选出 37 条渲染 template.html -> index.html，保证页面每天都有变化
// 抓不到新内容时仅靠轮换更新，程序不会失败退出。
import { readFileSync, writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TAG = { home: '家居清洁', kitchen: '厨房妙招', clothes: '衣物护理', food: '食品保鲜', health: '健康日常', storage: '收纳出行' };
const INCLUDE = ['清洁', '去污', '除味', '去除', '洗净', '清洗', '煮', '炒菜', '保存', '保鲜', '收纳', '整理', '防霉', '防潮', '驱', '保养', '修复', '剥', '腌', '种植', '浇', '叠', '熨', '水垢', '油污', '发霉', '结晶', '解冻', '止痒', '疏通', '除螨', '除去', '清除', '擦亮', '抛光', '自制', '制作肥皂', '系丝带', '包装礼品', '储存'];
const EXCLUDE = ['Windows', 'Mac', 'iPhone', '安卓', 'Android', '快捷指令', '轮盘', '赌', '电子邮件', '账号', '密码', '软件', '游戏', '股票', '贷款', '签证', '论文', '考试', '编程', '代码', '路由器', 'WiFi', 'wifi', '社交', 'Facebook', 'Instagram', 'TikTok', '约会', '宠物', '大麻', '纹身', '化妆', '发型', '美甲'];
const CAT_RULES = [
  ['kitchen', ['煮', '炒', '蒸', '烤', '食材', '厨房', '砧板', '锅', '蒜', '洋葱', '饺子', '腌']],
  ['food', ['保鲜', '保存食物', '储存食物', '冰箱', '香蕉', '柠檬', '面包', '大米', '蜂蜜结晶', '解冻']],
  ['clothes', ['衣', '鞋', '毛衣', '羽绒', '洗涤', '熨', '真丝', '皮革']],
  ['health', ['止痒', '蚊子', '落枕', '眼睛', '皮肤', '牙', '睡眠', '头痛']],
  ['storage', ['收纳', '整理', '行李', '旅行', '包装', '丝带', '礼品', '钥匙', '数据线']],
  ['home', ['清洁', '去污', '除味', '水垢', '油污', '地板', '玻璃', '镜子', '纱窗', '驱', '灭', '疏通', '发霉']],
];

function classify(title) {
  for (const [cat, keys] of CAT_RULES) if (keys.some(k => title.includes(k))) return cat;
  return 'home';
}
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}
async function fetchText(url, timeoutMs = 25000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } catch (e) {
    // fetch 直连失败时回退 curl（某些网络环境下 Node 的 TLS 指纹会被目标站拒绝）
    const { execFile } = await import('node:child_process');
    return await new Promise((resolve, reject) => {
      execFile('curl', ['-sL', '--max-time', '30', '-A', UA, url], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(new Error('curl 回退也失败：' + err.message));
        else if (!stdout || stdout.length < 200) reject(new Error('curl 返回内容过短'));
        else resolve(stdout);
      });
    });
  } finally { clearTimeout(timer); }
}

async function harvest(lib) {
  const known = new Set(lib.map(i => i.t));
  let added = 0;
  let home;
  try {
    home = await fetchText('https://zh.wikihow.com/');
  } catch (e) {
    console.log('抓取首页失败，跳过抓取：', e.message);
    return 0;
  }
  const hrefs = [...new Set([...home.matchAll(/class="hp_thumb_a" href="([^"]+)"/g)].map(m => m[1]))];
  console.log('首页文章链接：', hrefs.length);
  const candidates = [];
  for (const href of hrefs) {
    let title = '';
    try { title = decodeURIComponent(href).replace(/^\//, '').replace(/-/g, ' '); } catch { continue; }
    if (title.length < 4 || title.length > 30) continue;
    if (EXCLUDE.some(k => title.includes(k))) continue;
    if (!INCLUDE.some(k => title.includes(k))) continue;
    const cleanTitle = title.replace(/^如何/, '');
    if (known.has(cleanTitle)) continue;
    candidates.push({ title: cleanTitle, href });
  }
  console.log('符合生活类的新候选：', candidates.length);
  for (const cand of candidates.slice(0, 10)) {
    try {
      const page = await fetchText('https://zh.wikihow.com' + cand.href);
      const paras = [...page.matchAll(/<p>(.*?)<\/p>/gs)].map(m => stripTags(m[1])).filter(t => t.length > 40 && !t.includes('wikiHow') && !t.includes('参考文献'));
      if (!paras.length) continue;
      let text = paras[0];
      if (text.length > 150) text = text.slice(0, 147) + '…';
      lib.push({ t: cand.title, x: text, c: classify(cand.title) });
      known.add(cand.title);
      added++;
      console.log('新增：', cand.title);
    } catch (e) {
      console.log('抓取文章失败：', cand.title, e.message);
    }
  }
  return added;
}

async function main() {
  const lib = JSON.parse(readFileSync('data/tips.json', 'utf-8'));
  const added = await harvest(lib);
  // 题库上限 500：先淘汰非种子的旧条目
  while (lib.length > 500) {
    const idx = lib.findIndex(i => !i.s);
    if (idx === -1) break;
    lib.splice(idx, 1);
  }
  writeFileSync('data/tips.json', JSON.stringify(lib, null, 1), 'utf-8');

  const dayIndex = Math.floor(Date.now() / 86400000);
  const offset = lib.length ? dayIndex % lib.length : 0;
  const rotated = lib.slice(offset).concat(lib.slice(0, offset));
  const display = rotated.slice(0, 38);
  const daily = rotated[0] || { t: '', x: '' };
  const rank = rotated.slice(1, 11);

  const cardsHtml = display.map(i => `      <article class="tip-card" data-cat="${i.c}">
        <span class="tip-tag">${TAG[i.c] || '生活妙招'}</span>
        <h3 class="tip-title">${esc(i.t)}</h3>
        <p class="tip-text">${esc(i.x)}</p>
      </article>`).join('\n\n');
  const rankHtml = rank.map((i, n) => `        <li><span class="rank-num">${n + 1}</span>${esc(i.t)}</li>`).join('\n');
  const now = new Date();
  const updated = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

  let out = readFileSync('template.html', 'utf-8');
  out = out.replace('{{DAILY_TITLE}}', esc(daily.t));
  out = out.replace('{{DAILY_TEXT}}', esc(daily.x));
  out = out.replace('{{CARDS}}', cardsHtml);
  out = out.replace('{{RANK}}', rankHtml);
  out = out.replace('{{UPDATED}}', updated);
  writeFileSync('index.html', out, 'utf-8');
  console.log(`完成：题库 ${lib.length} 条，本次新增 ${added} 条，页面展示 ${display.length} 条，更新日期 ${updated}`);
}

main().catch(e => { console.error('更新程序异常（不拦截部署，保留旧页面）：', e); process.exit(0); });
