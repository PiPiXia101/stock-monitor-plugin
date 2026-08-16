#!/usr/bin/env node
/**
 * 回归验证（第一层）：用 test/ 数据跑正式代码 core.js，对照测试通过的契约行为。
 * 运行：node verify_core.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateStockCode,
  parseAnnouncements,
  parseNews,
  findNewNews,
  buildAnalysisPrompt,
  parseAnalysis,
  buildQAContext,
} from './dsh-plugin-stock-monitor/lib/core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const T = (f) => JSON.parse(readFileSync(path.join(__dirname, 'test', f), 'utf8'));

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
};
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };

console.log('== 回归验证：正式代码 core.js vs 测试数据 ==');

check('AC-2 合法代码通过/非法代码拒绝', () => {
  for (const s of T('stocks.json').stocks) if (!validateStockCode(s.code).ok) throw new Error(`${s.code} 应为合法`);
  for (const c of T('stocks.json').invalidCodes) if (validateStockCode(c).ok) throw new Error(`「${c}」应为非法`);
});

check('AC-3 构造新闻解析 10 条、字段齐全', () => {
  const items = parseNews(T('em_news_response_600519.json'));
  eq(items.length, 10);
  for (const it of items) if (!(it.id && it.title && it.source && it.time && it.url)) throw new Error('字段缺失');
});

check('AC-3 构造公告解析 2 条（缺字段跳过）', () => {
  eq(parseAnnouncements(T('em_ann_response_600519.json')).length, 2);
});

check('AC-3 空响应 0 条、异常响应全部容错', () => {
  eq(parseNews(T('em_news_response_empty.json')).length, 0);
  for (const c of T('em_news_response_abnormal.json').cases) {
    const got = parseNews(c.payload);
    if (!Array.isArray(got)) throw new Error(`「${c.name}」应返回数组`);
  }
});

check('AC-4 新新闻检测（全新增/部分新增/无新增）', () => {
  const all = parseNews(T('em_news_response_600519.json'));
  eq(findNewNews([], all).length, 10);
  eq(findNewNews(all.slice(2), all), [all[0].id, all[1].id]);
  eq(findNewNews(all, all), []);
});

check('AC-5 分析样本解析（利好/利空/中性/乱码/空串/结论在中间）', () => {
  const s = T('analysis_samples.json').samples;
  eq(parseAnalysis(s[0].raw).conclusion, '偏利好');
  eq(parseAnalysis(s[0].raw).points.length, 3);
  eq(parseAnalysis(s[1].raw).conclusion, '偏利空');
  eq(parseAnalysis(s[2].raw).conclusion, '中性');
  eq(parseAnalysis(s[3].raw).conclusion, '中性');
  eq(parseAnalysis(s[4].raw).points.length, 0);
  eq(parseAnalysis(s[5].raw).conclusion, '偏利好');
});

check('AC-6 prompt/上下文包含股票信息', () => {
  const all = parseNews(T('em_news_response_600519.json'));
  const p = buildAnalysisPrompt('600519', '贵州茅台', all);
  if (!(p.includes('600519') && p.includes('贵州茅台') && p.includes(all[0].title))) throw new Error('prompt 缺内容');
  const ctx = buildQAContext('600519', '贵州茅台', all, { conclusion: '偏利好' });
  if (!(ctx.includes('偏利好') && ctx.includes(all[0].title))) throw new Error('上下文缺内容');
});

check('生产数据：3 股票 + 3 ETF 新闻解析（各 10 条）', () => {
  for (const f of ['user_news_600519.json', 'user_news_000001.json', 'user_news_300750.json',
    'user_news_510300.json', 'user_news_512480.json', 'user_news_560450.json']) {
    const items = parseNews(T(f));
    if (items.length !== 10) throw new Error(`${f} 应为 10 条，实际 ${items.length}`);
  }
});

check('生产数据：3 股票公告各 5 条、3 ETF 公告为空', () => {
  for (const f of ['user_ann_600519.json', 'user_ann_000001.json', 'user_ann_300750.json']) {
    if (parseAnnouncements(T(f)).length !== 5) throw new Error(`${f} 应为 5 条`);
  }
  for (const f of ['user_ann_510300.json', 'user_ann_512480.json', 'user_ann_560450.json']) {
    if (parseAnnouncements(T(f)).length !== 0) throw new Error(`${f} 应为 0 条`);
  }
});

console.log(`\n回归验证（第一层）：通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
