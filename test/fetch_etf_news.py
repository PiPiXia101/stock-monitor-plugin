#!/usr/bin/env python3
# 一次性抓取脚本：从东方财富新闻搜索接口抓取 ETF 真实新闻存入 test/
# 来源：生产环境数据（真实接口抓取，2026-08-16）
import json, urllib.request, urllib.parse, ssl, subprocess, sys

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

TARGETS = [
    ("沪深300ETF", "user_news_510300.json"),
    ("半导体ETF", "user_news_512480.json"),
    ("电力ETF", "user_news_560450.json"),
]

def build_url(kw):
    param = json.dumps({
        "uid": "", "keyword": kw, "type": ["cmsArticleWebOld"], "client": "web",
        "clientType": "web", "clientVersion": "curr",
        "param": {"cmsArticleWebOld": {"searchScope": "default", "sort": "default",
            "pageIndex": 1, "pageSize": 10, "preTag": "", "postTag": ""}},
    }, ensure_ascii=False)
    return "https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=" + urllib.parse.quote(param)

for kw, out in TARGETS:
    url = build_url(kw)
    # 用 curl 子进程（Python urllib 与东财接口 TLS 握手有问题，curl 稳定）
    r = subprocess.run(
        ["curl", "-s", "--max-time", "20", url,
         "-H", "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"],
        capture_output=True, text=True)
    raw = r.stdout
    s = raw[raw.find("(") + 1: raw.rfind(")")]
    d = json.loads(s)
    arts = d.get("result", {}).get("cmsArticleWebOld", []) if isinstance(d.get("result"), dict) else []
    d["_comment"] = f"来源：生产环境数据。2026-08-16 从东方财富新闻搜索接口实时抓取（关键词：{kw}）"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    print(f"{out}: {len(arts)} 条 | 首条: {arts[0]['title'][:35] if arts else '无'}")
