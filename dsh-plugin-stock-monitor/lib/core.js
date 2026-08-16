/**
 * 股票监控插件 · 核心逻辑（正式代码）
 *
 * 契约：docs/函数契约.md（测试代码 test_stock_monitor.js 已验证同套逻辑，37 用例全通过）
 * 数据源：东方财富免费接口（2026-08-16 实测可用）
 * AI：DeepSeek API（key 来源：环境变量 DEEPSEEK_API_KEY 或 ~/.dsh/.credentials.yaml）
 */
'use strict';

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ============================================================
// 契约函数（与测试代码行为一致）
// ============================================================

/** AC-2：A 股代码校验。必须为 6 位数字 */
export function validateStockCode(code) {
  if (typeof code !== 'string' || code.trim() === '') {
    return { ok: false, reason: '股票代码不能为空' };
  }
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, reason: `「${code}」不是有效的 A 股代码，应为 6 位数字` };
  }
  return { ok: true };
}

/** AC-3：解析东财公告响应 → newsItem[]（type=announcement）。缺字段跳过，结构不符返回 [] */
export function parseAnnouncements(raw) {
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

/** AC-3：解析东财新闻搜索响应 → newsItem[]（type=news）。缺字段跳过，结构不符返回 [] */
export function parseNews(raw) {
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
export function findNewNews(prevItems, currItems) {
  const seen = new Set((prevItems || []).map((i) => i.id));
  return (currItems || [])
    .filter((i) => i && i.id && !seen.has(i.id))
    .map((i) => i.id);
}

/** AC-5：拼接 DeepSeek 分析 prompt */
export function buildAnalysisPrompt(code, name, items) {
  const lines = (items || [])
    .slice(0, 10)
    .map(
      (i, idx) =>
        `${idx + 1}. [${i.type}] ${i.title}（${i.source}，${i.time}）${i.content ? '：' + i.content.slice(0, 80) : ''}`
    )
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
export function parseAnalysis(rawText) {
  const raw = String(rawText == null ? '' : rawText);
  let conclusion = '中性';
  const m = raw.match(/结论\s*[:：]\s*(偏利好|偏利空|中性|利好|利空)/);
  if (m) {
    const c = m[1];
    conclusion = c === '利好' ? '偏利好' : c === '利空' ? '偏利空' : c;
  }
  let points = [];
  const pts = raw
    .split(/\n/)
    .filter((l) => /^\s*\d+[.、]/.test(l))
    .map((l) => l.replace(/^\s*\d+[.、]\s*/, '').trim());
  if (pts.length) {
    points = pts.slice(0, 5);
  } else if (raw.trim()) {
    points = [raw.trim().slice(0, 200)];
  }
  return { conclusion, points, raw };
}

/** AC-6：拼接提问上下文（股票信息 + 新闻清单 + 分析结论） */
export function buildQAContext(code, name, items, analysis) {
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

// ============================================================
// 东财数据抓取（生产环境接口）
// ============================================================

async function emFetch(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`东方财富接口 HTTP ${res.status}`);
  const text = await res.text();
  // 剥离 jsonp 包装：cb({...}) 或 jQueryxxx({...})
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start !== -1 && end > start) return JSON.parse(text.slice(start + 1, end));
  return JSON.parse(text);
}

/** 查询股票/ETF 名称（push2 行情接口；深市 secid=0，沪市 secid=1） */
export async function fetchStockName(code) {
  for (const market of ['1', '0']) {
    try {
      const d = await emFetch(
        `https://push2.eastmoney.com/api/qt/stock/get?secid=${market}.${code}&fields=f57,f58`
      );
      if (d && d.data && d.data.f58) return String(d.data.f58);
    } catch {
      /* 试下一个市场 */
    }
  }
  return '';
}

/** 抓取公告（ETF 返回空列表属正常） */
export async function fetchAnnouncements(code) {
  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=10&page_index=1&ann_type=A&client_source=web&stock_list=${code}`;
  const raw = await emFetch(url);
  return parseAnnouncements(raw);
}

/** 抓取新闻（按名称关键词搜索） */
export async function fetchNewsByName(name) {
  if (!name) return [];
  const param = JSON.stringify({
    uid: '',
    keyword: name,
    type: ['cmsArticleWebOld'],
    client: 'web',
    clientType: 'web',
    clientVersion: 'curr',
    param: {
      cmsArticleWebOld: {
        searchScope: 'default',
        sort: 'default',
        pageIndex: 1,
        pageSize: 10,
        preTag: '',
        postTag: '',
      },
    },
  });
  const url =
    'https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=' + encodeURIComponent(param);
  const raw = await emFetch(url);
  return parseNews(raw);
}

/** 单只股票全量抓取：公告 + 新闻，按时间倒序合并 */
export async function fetchStockItems(code, name) {
  const [anns, news] = await Promise.all([fetchAnnouncements(code), fetchNewsByName(name)]);
  const merged = [...news, ...anns].sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  return merged;
}

// ============================================================
// DeepSeek API
// ============================================================

/** 读取 DEEPSEEK_API_KEY：环境变量优先，其次 ~/.dsh/.credentials.yaml */
export function resolveApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  try {
    const credPath = path.join(homedir(), '.dsh', '.credentials.yaml');
    if (existsSync(credPath)) {
      const text = readFileSync(credPath, 'utf8');
      const m = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(.+)\s*$/m);
      if (m) return m[1].replace(/^['"]|['"]$/g, '').trim();
    }
  } catch {
    /* 忽略读取失败 */
  }
  return '';
}

/** 调用 DeepSeek 补全 */
export async function deepseekChat(prompt, model = 'deepseek-chat') {
  const key = resolveApiKey();
  if (!key) throw new Error('未找到 DEEPSEEK_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）');
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 800,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`DeepSeek API HTTP ${res.status}`);
  const d = await res.json();
  return d.choices && d.choices[0] && d.choices[0].message
    ? d.choices[0].message.content
    : '';
}

/** 生成分析 */
export async function analyzeStock(code, name, items) {
  const prompt = buildAnalysisPrompt(code, name, items);
  const raw = await deepseekChat(prompt);
  return parseAnalysis(raw);
}

/** 结合新闻上下文回答提问 */
export async function askAboutStock(code, name, items, analysis, question) {
  const context = buildQAContext(code, name, items, analysis);
  const prompt = `${context}\n\n用户问题：${question}\n\n请结合上面的新闻与分析结论回答，简明扼要。`;
  return deepseekChat(prompt, 'deepseek-chat');
}
