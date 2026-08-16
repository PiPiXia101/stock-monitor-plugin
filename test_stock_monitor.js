#!/usr/bin/env node
/**
 * 股票监控插件 · 测试样例（本地可运行）
 *
 * 运行：node test_stock_monitor.js
 * 数据：读取 test/ 目录下 JSON 数据文件（不硬编码输入）
 * 契约：docs/函数契约.md
 *
 * 测试通过定义 = 每条验收标准（AC-1 ~ AC-7）都有对应用例且全部通过。
 * AC-1（侧边栏入口）为 UI 层面，无法在 Node 中自动化，测试末尾输出人工验收清单。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = path.join(__dirname, 'test');
const load = (f) => JSON.parse(fs.readFileSync(path.join(TEST_DIR, f), 'utf8'));

// ============================================================
// 契约函数实现（正式代码将复用/移植本逻辑，保持行为一致）
// ============================================================

/** AC-2：A 股代码校验。必须为 6 位数字 */
function validateStockCode(code) {
  if (typeof code !== 'string' || code.trim() === '') {
    return { ok: false, reason: '股票代码不能为空' };
  }
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, reason: `「${code}」不是有效的 A 股代码，应为 6 位数字` };
  }
  return { ok: true };
}

/** AC-3：解析东财公告响应 → newsItem[]（type=announcement）。缺字段条目跳过，结构不符返回 [] */
function parseAnnouncements(raw) {
  if (!raw || typeof raw !== 'object' || !raw.data || !Array.isArray(raw.data.list)) return [];
  const out = [];
  for (const it of raw.data.list) {
    if (!it || typeof it !== 'object' || !it.art_code || !it.title) continue;
    const code = (it.codes && it.codes[0] && it.codes[0].stock_code) || '';
    out.push({
      id: String(it.art_code),
      title: String(it.title),
      source: code || '公告',
      time: String(it.display_time || it.notice_date || '').replace(/:(\d+)$/, ''),
      url: `https://data.eastmoney.com/notices/detail/${code}/${it.art_code}.html`,
      content: '',
      type: 'announcement',
    });
  }
  return out;
}

/** AC-3：解析东财新闻搜索响应 → newsItem[]（type=news）。缺字段条目跳过，结构不符返回 [] */
function parseNews(raw) {
  if (!raw || typeof raw !== 'object' || !raw.result || !Array.isArray(raw.result.cmsArticleWebOld)) return [];
  const out = [];
  for (const it of raw.result.cmsArticleWebOld) {
    if (!it || typeof it !== 'object' || !it.code || !it.title || !it.url) continue;
    out.push({
      id: String(it.code),
      title: String(it.title),
      source: String(it.mediaName || '东方财富'),
      time: String(it.date || ''),
      url: String(it.url),
      content: String(it.content || ''),
      type: 'news',
    });
  }
  return out;
}

/** AC-4：对比新旧新闻，返回 curr 中 prev 没有的 id（按 curr 顺序，新→旧） */
function findNewNews(prevItems, currItems) {
  const seen = new Set((prevItems || []).map((i) => i.id));
  return (currItems || [])
    .filter((i) => i && i.id && !seen.has(i.id))
    .map((i) => i.id);
}

/** AC-5：拼接 DeepSeek 分析 prompt */
function buildAnalysisPrompt(code, name, items) {
  const lines = (items || [])
    .slice(0, 10)
    .map((i, idx) => `${idx + 1}. [${i.type}] ${i.title}（${i.source}，${i.time}）${i.content ? '：' + i.content.slice(0, 80) : ''}`)
    .join('\n');
  return [
    `你是A股分析助手。请分析以下股票（代码 ${code} ${name || ''}）最近的相关新闻，`,
    '给出结论（只能是：偏利好 / 偏利空 / 中性）和 2-5 条要点。格式：',
    '结论：偏利好\n要点：\n1. ...\n2. ...',
    '---新闻清单---',
    lines || '（暂无新闻）',
  ].join('\n');
}

/** AC-5：解析 DeepSeek 返回文本 → {conclusion, points, raw}。无法识别时结论=中性 */
function parseAnalysis(rawText) {
  const raw = String(rawText == null ? '' : rawText);
  let conclusion = '中性';
  const m = raw.match(/结论\s*[:：]\s*(偏利好|偏利空|中性|利好|利空)/);
  if (m) {
    const c = m[1];
    conclusion = c === '利好' ? '偏利好' : c === '利空' ? '偏利空' : c;
  }
  let points = [];
  const pts = raw.split(/\n/).filter((l) => /^\s*\d+[.、]/.test(l)).map((l) => l.replace(/^\s*\d+[.、]\s*/, '').trim());
  if (pts.length) {
    points = pts.slice(0, 5);
  } else if (raw.trim()) {
    points = [raw.trim().slice(0, 200)];
  }
  return { conclusion, points, raw };
}

/** AC-6：拼接提问上下文（股票信息 + 新闻清单 + 分析结论） */
function buildQAContext(code, name, items, analysis) {
  const news = (items || [])
    .slice(0, 10)
    .map((i) => `- [${i.type}] ${i.title}（${i.source}，${i.time}）`)
    .join('\n');
  const conclusion = analysis && analysis.conclusion ? analysis.conclusion : '（尚未分析）';
  return [
    `以下是股票 ${code} ${name || ''} 的新闻与分析结论，请基于这些内容回答用户问题：`,
    `分析结论：${conclusion}`,
    '---新闻---',
    news || '（暂无新闻）',
  ].join('\n');
}

/** AC-7：自选股存储（内存版，正式代码持久化到文件） */
function createWatchlistStore() {
  const items = [];
  return {
    list: () => items.map((s) => ({ ...s })),
    add(code, name) {
      const v = validateStockCode(code);
      if (!v.ok) return { ok: false, reason: v.reason };
      if (items.some((s) => s.code === code)) return { ok: false, reason: `股票 ${code} 已在自选列表中` };
      items.push({ code, name: name || '', addedAt: new Date().toISOString() });
      return { ok: true };
    },
    remove(code) {
      const i = items.findIndex((s) => s.code === code);
      if (i === -1) return { ok: false, reason: `股票 ${code} 不在自选列表中` };
      items.splice(i, 1);
      return { ok: true };
    },
  };
}

// ============================================================
// 测试框架
// ============================================================
let passed = 0;
let failed = 0;
const failures = [];

function testCase(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed += 1;
    failures.push({ name, error: e });
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

// ============================================================
// 用例
// ============================================================
const stocks = load('stocks.json');
const newsResp = load('em_news_response_600519.json');
const annResp = load('em_ann_response_600519.json');
const emptyResp = load('em_news_response_empty.json');
const abnormal = load('em_news_response_abnormal.json');
const analysisSamples = load('analysis_samples.json');

section('AC-2 股票代码校验');
testCase('合法 A 股代码全部通过（600519/000001/300750）', () => {
  for (const s of stocks.stocks) {
    assert.equal(validateStockCode(s.code).ok, true, `${s.code} 应为合法`);
  }
});
testCase('非法代码全部拒绝（空串/字母/5位/7位/含空格/全角数字/混合）', () => {
  for (const c of stocks.invalidCodes) {
    assert.equal(validateStockCode(c).ok, false, `「${c}」应为非法`);
  }
});
testCase('非字符串输入拒绝（null/undefined/数字）', () => {
  assert.equal(validateStockCode(null).ok, false);
  assert.equal(validateStockCode(undefined).ok, false);
  assert.equal(validateStockCode(600519).ok, false);
});

section('AC-3 新闻/公告解析');
testCase('新闻响应解析出 10 条，字段齐全（id/title/source/time/url/type）', () => {
  const items = parseNews(newsResp);
  assert.equal(items.length, 10);
  for (const it of items) {
    assert.ok(it.id && it.title && it.source && it.time && it.url, `条目字段缺失: ${JSON.stringify(it)}`);
    assert.equal(it.type, 'news');
  }
});
testCase('公告响应解析出 2 条（缺字段的第 3 条被跳过）', () => {
  const items = parseAnnouncements(annResp);
  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'announcement');
  assert.ok(items[0].title.includes('业绩说明会'));
});
testCase('空响应解析为 0 条', () => {
  assert.equal(parseNews(emptyResp).length, 0);
});
testCase('异常响应全部容错：返回 [] 不抛异常', () => {
  for (const c of abnormal.cases) {
    let got;
    assert.doesNotThrow(() => { got = parseNews(c.payload); });
    assert.ok(Array.isArray(got), `用例「${c.name}」应返回数组`);
    assert.equal(typeof got.length, 'number');
  }
});
testCase('公告接口异常（data 缺失）返回 [] 不崩溃', () => {
  const badCase = abnormal.cases.find((c) => c.name.includes('公告接口'));
  let got;
  assert.doesNotThrow(() => { got = parseAnnouncements(badCase.payload); });
  assert.equal(got.length, 0);
});

section('AC-4 新新闻检测');
const allNews = parseNews(newsResp); // 10 条，新→旧
testCase('prev 为空 → 10 条全部为新增', () => {
  const newIds = findNewNews([], allNews);
  assert.equal(newIds.length, 10);
});
testCase('prev 为旧 8 条 → 新增为最新 2 条，且保持新→旧顺序', () => {
  const prev = allNews.slice(2); // 去掉最新的 2 条
  const newIds = findNewNews(prev, allNews);
  assert.deepEqual(newIds, [allNews[0].id, allNews[1].id]);
});
testCase('curr 为空 → 无新增', () => {
  assert.deepEqual(findNewNews(allNews, []), []);
});
testCase('id 相同内容不同 → 不算新增', () => {
  const prev = allNews.slice(0, 3);
  const curr = allNews.slice(0, 3).map((i) => ({ ...i, title: i.title + '（改）' }));
  assert.deepEqual(findNewNews(prev, curr), []);
});
testCase('prev 与 curr 完全相同 → 无新增', () => {
  assert.deepEqual(findNewNews(allNews, allNews), []);
});

section('AC-5 AI 分析 prompt 与解析');
testCase('分析 prompt 包含代码/名称/新闻标题', () => {
  const p = buildAnalysisPrompt('600519', '贵州茅台', allNews);
  assert.ok(p.includes('600519'));
  assert.ok(p.includes('贵州茅台'));
  assert.ok(p.includes(allNews[0].title));
});
testCase('偏利好样本解析出 偏利好 + 3 要点', () => {
  const r = parseAnalysis(analysisSamples.samples[0].raw);
  assert.equal(r.conclusion, '偏利好');
  assert.equal(r.points.length, 3);
});
testCase('偏利空样本解析出 偏利空', () => {
  assert.equal(parseAnalysis(analysisSamples.samples[1].raw).conclusion, '偏利空');
});
testCase('中性样本解析出 中性', () => {
  assert.equal(parseAnalysis(analysisSamples.samples[2].raw).conclusion, '中性');
});
testCase('乱码文本 → 结论中性，points 含原文截断', () => {
  const r = parseAnalysis(analysisSamples.samples[3].raw);
  assert.equal(r.conclusion, '中性');
  assert.equal(r.points.length, 1);
});
testCase('空字符串 → 结论中性，points 为空', () => {
  const r = parseAnalysis(analysisSamples.samples[4].raw);
  assert.equal(r.conclusion, '中性');
  assert.equal(r.points.length, 0);
});
testCase('结论词在文本中间也能识别', () => {
  assert.equal(parseAnalysis(analysisSamples.samples[5].raw).conclusion, '偏利好');
});

section('AC-6 提问上下文');
testCase('提问上下文包含代码/名称/新闻/分析结论', () => {
  const analysis = { conclusion: '偏利好' };
  const ctx = buildQAContext('600519', '贵州茅台', allNews, analysis);
  assert.ok(ctx.includes('600519'));
  assert.ok(ctx.includes('贵州茅台'));
  assert.ok(ctx.includes('偏利好'));
  assert.ok(ctx.includes(allNews[0].title));
});
testCase('无新闻/未分析时上下文不崩溃且有占位', () => {
  const ctx = buildQAContext('600519', '贵州茅台', [], null);
  assert.ok(ctx.includes('（暂无新闻）'));
  assert.ok(ctx.includes('（尚未分析）'));
});

section('AC-7 自选股存储');
testCase('添加/列表/删除全流程', () => {
  const store = createWatchlistStore();
  assert.equal(store.add('600519', '贵州茅台').ok, true);
  assert.equal(store.add('000001', '平安银行').ok, true);
  assert.equal(store.list().length, 2);
  assert.equal(store.remove('600519').ok, true);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].code, '000001');
});
testCase('重复添加被拒绝', () => {
  const store = createWatchlistStore();
  store.add('600519', '贵州茅台');
  const r = store.add('600519', '贵州茅台');
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('已'));
});
testCase('非法代码添加被拒绝', () => {
  const store = createWatchlistStore();
  assert.equal(store.add('abc', '').ok, false);
  assert.equal(store.list().length, 0);
});
testCase('删除不存在的股票返回错误不崩溃', () => {
  const store = createWatchlistStore();
  const r = store.remove('999999');
  assert.equal(r.ok, false);
});

section('用户手动数据（生产环境）· 真实接口抓取');
const userNews600 = load('user_news_600519.json');
const userNews001 = load('user_news_000001.json');
const userNews300 = load('user_news_300750.json');
const userAnn600 = load('user_ann_600519.json');
const userAnn001 = load('user_ann_000001.json');
const userAnn300 = load('user_ann_300750.json');
testCase('真实数据：600519 新闻解析 10 条、字段齐全', () => {
  const items = parseNews(userNews600);
  assert.equal(items.length, 10);
  for (const it of items) assert.ok(it.id && it.title && it.source && it.time && it.url);
});
testCase('真实数据：000001 新闻解析 10 条、字段齐全', () => {
  const items = parseNews(userNews001);
  assert.equal(items.length, 10);
  for (const it of items) assert.ok(it.id && it.title && it.source && it.time && it.url);
});
testCase('真实数据：300750 新闻解析 10 条、字段齐全', () => {
  const items = parseNews(userNews300);
  assert.equal(items.length, 10);
  for (const it of items) assert.ok(it.id && it.title && it.source && it.time && it.url);
});
testCase('真实数据：三只股票公告各解析出 5 条', () => {
  assert.equal(parseAnnouncements(userAnn600).length, 5);
  assert.equal(parseAnnouncements(userAnn001).length, 5);
  assert.equal(parseAnnouncements(userAnn300).length, 5);
});
testCase('真实数据：600519 两次刷新对比（前 8 条为旧）→ 新增最新 2 条', () => {
  const all = parseNews(userNews600);
  const prev = all.slice(2);
  const newIds = findNewNews(prev, all);
  assert.deepEqual(newIds, [all[0].id, all[1].id]);
});
testCase('真实数据：000001 新新闻检测 prev 为空 → 全部新增', () => {
  const all = parseNews(userNews001);
  assert.equal(findNewNews([], all).length, 10);
});
testCase('真实数据：300750 分析 prompt 含股票信息与新闻', () => {
  const all = parseNews(userNews300);
  const p = buildAnalysisPrompt('300750', '宁德时代', all);
  assert.ok(p.includes('300750') && p.includes('宁德时代') && p.includes(all[0].title));
});
testCase('真实数据（用户持仓）：510300 沪深300ETF 新闻解析 10 条、字段齐全', () => {
  const items = parseNews(load('user_news_510300.json'));
  assert.equal(items.length, 10);
  for (const it of items) assert.ok(it.id && it.title && it.source && it.time && it.url);
});
testCase('真实数据（用户持仓）：512480 半导体ETF 新闻解析 10 条、字段齐全', () => {
  const items = parseNews(load('user_news_512480.json'));
  assert.equal(items.length, 10);
  for (const it of items) assert.ok(it.id && it.title && it.source && it.time && it.url);
});
testCase('真实数据（用户持仓）：560450 电力ETF 新闻解析 10 条、字段齐全', () => {
  const items = parseNews(load('user_news_560450.json'));
  assert.equal(items.length, 10);
  for (const it of items) assert.ok(it.id && it.title && it.source && it.time && it.url);
});
testCase('真实数据（用户持仓）：三只 ETF 公告接口返回空 → 解析为 0 条且不崩溃（ETF 无股票公告属正常）', () => {
  for (const f of ['user_ann_510300.json', 'user_ann_512480.json', 'user_ann_560450.json']) {
    let got;
    assert.doesNotThrow(() => { got = parseAnnouncements(load(f)); });
    assert.equal(got.length, 0, `${f} 应为 0 条`);
  }
});

// ============================================================
// 汇总
// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`通过：${passed}  失败：${failed}`);
if (failed > 0) {
  console.log('\n失败用例：');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error.message}`);
  process.exit(1);
}

console.log(`
人工验收清单（UI 层面，挂载后逐项人工验证）：
  [ ] AC-1 DSH web 侧边栏出现「股票监控」入口，点击进入面板
  [ ] AC-6 面板提问框输入问题，返回结合新闻上下文的回答
`);
console.log('测试通过判定：脚本 0 退出码 + 全部用例 ✅ = 测试通过（脚本不报错不算通过）');
