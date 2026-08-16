# 股票监控插件（dsh-plugin-stock-monitor）

DSH（DeepSeek Harness）的股票监控插件：输入 A 股/ETF 代码，自动抓取相关新闻与公告，5 分钟定时刷新，新新闻高亮提醒；可调用 DeepSeek API 生成 AI 分析（偏利好/偏利空/中性 + 要点），并支持结合新闻上下文提问。

## 功能

- 侧边栏「📈 股票监控」入口 → 独立面板页面
- 添加/删除自选股（6 位数字 A 股代码校验，自动识别证券名称）
- 每 5 分钟自动刷新新闻/公告，新新闻黄色高亮置顶
- AI 分析（DeepSeek）：结论 + 要点，附"仅供参考，不构成投资建议"声明
- 面板内提问：AI 结合该股票已抓取的新闻与分析结论回答
- 数据持久化（`~/.dsh/stock-monitor-data.json`）

## 安装（挂载到 DSH）

1. 将本包软链接到 DSH profile 的依赖目录：
   ```bash
   ln -sfn <本仓库路径>/dsh-plugin-stock-monitor ~/.dsh/profiles/node_modules/dsh-plugin-stock-monitor
   ```
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：
   ```yaml
   - insert:
       - id: stock-monitor
         name: dsh-plugin-stock-monitor
         config:
           refreshIntervalMs: 300000
   ```
3. 重启 DSH web（`dsh web`），刷新页面后侧边栏底部出现「📈 股票监控」。

## 数据源与 AI

- 新闻/公告：东方财富免费接口（`np-anotice-stock.eastmoney.com`、`search-api-web.eastmoney.com`），经 `curl` 子进程抓取（该接口对 Node fetch/Python 客户端返回非新闻内容，故用 curl）。
- AI：DeepSeek API，key 读取环境变量 `DEEPSEEK_API_KEY`，或 `~/.dsh/.credentials.yaml` 中的 `DEEPSEEK_API_KEY`。代码不含任何密钥。

## 开发与测试

- 测试数据 `test/` 目录**不入库**（含真实接口抓取的生产数据），需在本地按需生成：`node test_stock_monitor.js`（37 用例，读取 `test/` 数据）。
- 回归：`node verify_core.mjs`（9 项，用 `test/` 数据验证正式代码解析逻辑）。

## 免责声明

AI 分析结果仅供参考，不构成任何投资建议。东方财富为免费接口，无 SLA 保障，插件已做异常容错但无法保证长期可用。
