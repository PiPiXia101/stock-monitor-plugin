/**
 * 股票监控插件 · 客户端（浏览器端）
 *
 * 在侧边栏底部（sidebar.footer.action，list 类型）注册「股票监控」入口按钮，
 * 点击后新标签页打开独立面板 /stock-monitor/。
 *
 * 模式参考：@deepseek-ai/dsh-client-ui-cordis 的 sidebar.footer.action 注册。
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-stock-monitor",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    /**
     * 侧边栏底部入口按钮。
     * props 由 slot 系统注入（此处无特殊依赖）。
     */
    function StockMonitorEntry(props) {
      return react.createElement(
        "button",
        {
          type: "button",
          "aria-label": "股票监控",
          title: "打开股票监控面板（新标签页）",
          onClick: () => {
            window.open("/stock-monitor/", "_blank", "noopener");
          },
          style: {
            width: "100%",
            height: 36,
            border: "1px solid var(--dsw-alias-border-l2, #e2e5ea)",
            background: "transparent",
            color: "var(--dsw-alias-label-primary, #1f2329)",
            borderRadius: 10,
            cursor: "pointer",
            font: "inherit",
            fontSize: 13,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            padding: "0 8px",
            flex: "none",
          },
          onMouseEnter: (e) => {
            e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, #eef0f3)";
          },
          onMouseLeave: (e) => {
            e.currentTarget.style.background = "transparent";
          },
        },
        "📈 股票监控"
      );
    }

    function apply(ctx) {
      ctx.effect(() =>
        ctx.slots.inject("sidebar.footer.action", () =>
          ctx.slots.register(
            {
              name: "sidebar.footer.action",
              id: "stock-monitor-entry",
              inject: () => ({}),
            },
            StockMonitorEntry
          )
        ),
        "stock-monitor: sidebar entry"
      );
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
