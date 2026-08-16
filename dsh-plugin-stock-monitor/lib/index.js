/**
 * 股票监控插件 · 服务端 cordis 插件
 *
 * 提供：
 *  - REST API（prefix /api/stock）：自选股 CRUD / 刷新 / AI 分析 / 提问
 *  - 静态面板（prefix /stock-monitor）：独立页面（HTML/JS/CSS）
 *  - 定时刷新（默认 5 分钟）：抓取新闻，标记新新闻
 *
 * 挂载：cordis.patch.yml 中 name: dsh-plugin-stock-monitor
 */
'use strict';

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateStockCode,
  fetchStockName,
  fetchStockItems,
  findNewNews,
  analyzeStock,
  askAboutStock,
} from './core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const name = 'stock-monitor';
export const inject = ['webServer'];

const DEFAULT_CONFIG = {
  refreshIntervalMs: 5 * 60 * 1000,
  dataFile: path.join(homedir(), '.dsh', 'stock-monitor-data.json'),
  deepseekModel: 'deepseek-chat',
};

// ============================================================
// 持久化存储
// ============================================================

class Store {
  constructor(file) {
    this.file = file;
    this.data = { stocks: [], snapshots: {} };
    this.load();
  }
  load() {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        if (raw && Array.isArray(raw.stocks)) this.data = raw;
      }
    } catch {
      /* 损坏则重置 */
    }
  }
  save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.error('[stock-monitor] 持久化失败:', e.message);
    }
  }
  listStocks() {
    return this.data.stocks.map((s) => ({ ...s }));
  }
  findStock(code) {
    return this.data.stocks.find((s) => s.code === code);
  }
  addStock(code, name) {
    const v = validateStockCode(code);
    if (!v.ok) return { ok: false, reason: v.reason };
    if (this.findStock(code)) return { ok: false, reason: `股票 ${code} 已在自选列表中` };
    const stock = { code, name: name || '', addedAt: new Date().toISOString() };
    this.data.stocks.push(stock);
    this.save();
    return { ok: true, stock };
  }
  removeStock(code) {
    const i = this.data.stocks.findIndex((s) => s.code === code);
    if (i === -1) return { ok: false, reason: `股票 ${code} 不在自选列表中` };
    this.data.stocks.splice(i, 1);
    delete this.data.snapshots[code];
    this.save();
    return { ok: true };
  }
  getSnapshot(code) {
    return this.data.snapshots[code] || null;
  }
  setSnapshot(code, snap) {
    this.data.snapshots[code] = snap;
    this.save();
  }
}

// ============================================================
// 刷新逻辑
// ============================================================

async function refreshOne(store, stock, config) {
  try {
    const items = await fetchStockItems(stock.code, stock.name);
    const prev = store.getSnapshot(stock.code);
    const prevItems = prev && Array.isArray(prev.items) ? prev.items : [];
    const newIds = findNewNews(prevItems, items);
    const analysis = prev && prev.analysis ? prev.analysis : null;
    const snap = {
      items,
      newIds,
      refreshedAt: new Date().toISOString(),
      analysis,
      error: null,
    };
    store.setSnapshot(stock.code, snap);
    return { ok: true, newIds };
  } catch (e) {
    const prev = store.getSnapshot(stock.code);
    store.setSnapshot(stock.code, {
      items: prev && Array.isArray(prev.items) ? prev.items : [],
      newIds: [],
      refreshedAt: prev ? prev.refreshedAt : null,
      analysis: prev && prev.analysis ? prev.analysis : null,
      error: `刷新失败：${e.message}`,
    });
    return { ok: false, error: e.message };
  }
}

async function refreshAll(store, config) {
  const stocks = store.listStocks();
  const results = await Promise.all(stocks.map((s) => refreshOne(store, s, config)));
  return results;
}

// ============================================================
// HTTP 工具
// ============================================================

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ============================================================
// 插件主体
// ============================================================

export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  const store = new Store(cfg.dataFile);

  // ── REST API：/api/stock/* ──────────────────────────────────
  ctx.webServer.register({
    kind: 'prefix',
    path: '/api/stock',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const route = url.pathname.replace(/^\/api\/stock\/?/, '').split('/')[0];
        const method = req.method || 'GET';

        // GET /api/stock/watchlist —— 自选股 + 快照
        if (method === 'GET' && (route === 'watchlist' || route === '')) {
          const stocks = store.listStocks().map((s) => ({
            ...s,
            snapshot: store.getSnapshot(s.code),
          }));
          return sendJson(res, 200, { ok: true, stocks });
        }

        // POST /api/stock/watchlist —— 添加（自动查名称并立即刷新一次）
        if (method === 'POST' && route === 'watchlist') {
          const body = await readBody(req);
          const code = String(body.code || '').trim();
          const v = validateStockCode(code);
          if (!v.ok) return sendJson(res, 400, { ok: false, reason: v.reason });
          const name = await fetchStockName(code);
          if (!name) return sendJson(res, 400, { ok: false, reason: `未找到代码 ${code} 对应的证券，请检查代码` });
          const r = store.addStock(code, name);
          if (!r.ok) return sendJson(res, 400, { ok: false, reason: r.reason });
          await refreshOne(store, r.stock, config);
          const stock = { ...r.stock, snapshot: store.getSnapshot(code) };
          return sendJson(res, 200, { ok: true, stock });
        }

        // DELETE /api/stock/watchlist?code=xxx —— 删除
        if (method === 'DELETE' && route === 'watchlist') {
          const code = url.searchParams.get('code');
          const r = store.removeStock(String(code || ''));
          if (!r.ok) return sendJson(res, 400, { ok: false, reason: r.reason });
          return sendJson(res, 200, { ok: true });
        }

        // POST /api/stock/refresh —— 刷新（body.code 为空则全部）
        if (method === 'POST' && route === 'refresh') {
          const body = await readBody(req);
          if (body.code) {
            const stock = store.findStock(String(body.code));
            if (!stock) return sendJson(res, 404, { ok: false, reason: '股票不在自选列表' });
            const r = await refreshOne(store, stock, config);
            return sendJson(res, r.ok ? 200 : 500, { ok: r.ok, error: r.error || null });
          }
          await refreshAll(store, config);
          return sendJson(res, 200, { ok: true });
        }

        // POST /api/stock/analyze —— AI 分析
        if (method === 'POST' && route === 'analyze') {
          const body = await readBody(req);
          const stock = store.findStock(String(body.code || ''));
          if (!stock) return sendJson(res, 404, { ok: false, reason: '股票不在自选列表' });
          const snap = store.getSnapshot(stock.code);
          const items = snap && Array.isArray(snap.items) ? snap.items : [];
          try {
            const analysis = await analyzeStock(stock.code, stock.name, items);
            store.setSnapshot(stock.code, { ...(snap || {}), analysis });
            return sendJson(res, 200, { ok: true, analysis });
          } catch (e) {
            return sendJson(res, 500, { ok: false, reason: `AI 分析失败：${e.message}` });
          }
        }

        // POST /api/stock/ask —— 结合新闻上下文提问
        if (method === 'POST' && route === 'ask') {
          const body = await readBody(req);
          const stock = store.findStock(String(body.code || ''));
          if (!stock) return sendJson(res, 404, { ok: false, reason: '股票不在自选列表' });
          const question = String(body.question || '').trim();
          if (!question) return sendJson(res, 400, { ok: false, reason: '问题不能为空' });
          const snap = store.getSnapshot(stock.code);
          const items = snap && Array.isArray(snap.items) ? snap.items : [];
          try {
            const answer = await askAboutStock(stock.code, stock.name, items, snap ? snap.analysis : null, question);
            return sendJson(res, 200, { ok: true, answer });
          } catch (e) {
            return sendJson(res, 500, { ok: false, reason: `提问失败：${e.message}` });
          }
        }

        return sendJson(res, 404, { ok: false, reason: `未知接口 /api/stock/${route}` });
      } catch (e) {
        return sendJson(res, 500, { ok: false, reason: e.message });
      }
    },
  });

  // ── 静态面板：/stock-monitor/* ──────────────────────────────
  const panelHtml = readFileSync(path.join(__dirname, 'panel.html'), 'utf8');
  ctx.webServer.register({
    kind: 'prefix',
    path: '/stock-monitor',
    handler: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(panelHtml);
    },
  });

  // ── 定时刷新（默认 5 分钟）──────────────────────────────────
  const timer = setInterval(() => {
    refreshAll(store, config).catch((e) => {
      console.error('[stock-monitor] 定时刷新失败:', e.message);
    });
  }, cfg.refreshIntervalMs);
  timer.unref?.();

  // 启动时先刷一次
  refreshAll(store, config).catch((e) => {
    console.error('[stock-monitor] 启动刷新失败:', e.message);
  });

  ctx.on('dispose', () => {
    clearInterval(timer);
  });

  console.log(`[stock-monitor] 插件已启动：自选股 ${store.listStocks().length} 只，刷新间隔 ${cfg.refreshIntervalMs}ms，数据文件 ${cfg.dataFile}`);
}
