# STATUS

- 阶段：回归（服务端抓取修复已提交，等待用户重启 DSH web 后做全链路验证）
- 进度：
  - [x] 需求澄清 → 需求确认书（用户确认）→ 测试样例 37 用例通过（用户确认）
  - [x] 正式插件包开发（core.js / index.js / client.js / panel.html）
  - [x] 挂载（cordis.patch.yml + symlink）+ git 提交
  - [x] 修复 1：客户端 inject 声明（用户重启后报错，已修复，侧边栏按钮已验证出现 ✅）
  - [x] 修复 2：新闻抓取为空（东财接口对 Node fetch/Python 返回非新闻，改 curl 子进程；510300→10条/600519→20条实测通过）
  - [ ] 重启 DSH web（用户自行重启，进行中）
  - [ ] 全链路验证：新闻抓取 / AI 分析 / 提问（DeepSeek API）
  - [ ] 面板人工验收（AC-1 侧边栏入口已见 / AC-6 提问框）
  - [ ] 关闭
- 已用问题号：REQ-001
- 下一步：用户重启完成后，验证 /api/stock/watchlist 是否返回新闻；然后测分析+提问
