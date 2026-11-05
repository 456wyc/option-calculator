# A 股期权计算器

实时行情 · 持仓管理 · 组合收益分析 · 单笔策略快速试算

一个 **零第三方依赖**（仅 Python 标准库）的 A 股 ETF / 股指期权研究工具：自带行情网关（东方财富公开接口）、Black-Scholes 期权定价与 Greeks 估算、SQLite 本地持仓，以及纯前端（原生 Canvas 图表）交互界面。

> 行情数据来自第三方公开接口，可能有延迟；本工具仅用于策略研究与盈亏测算，**不构成任何投资建议**。

## ✨ 特性

- **实时行情看板**：T 型报价（认购 / 认沽），含最新价、涨跌幅、IV、Delta、成交量、持仓量；红涨绿跌，实值合约高亮；覆盖 12 个标的、按月切换到期合约。
- **行情快速收益试算**：在任意合约「最新价」右上角的 `∑` 按钮，一键弹出按当前价快速测算收益（盈亏、收益率、保证金、盈亏平衡价与迷你盈亏曲线）。
- **持仓管理**：买入 / 卖出开仓，部分平仓，自定义现价盯市；逐腿计算浮动盈亏、收益率、IV、Delta、保证金。
- **组合收益分析**：组合盈亏曲线（到期 + 当前理论）、各持仓盈亏贡献双向条形图、按标的分组汇总（Delta 市值、保证金）。
- **单笔策略试算**：输入开仓 / 平仓权利金，计算盈亏、收益率、盈亏平衡价，并绘制单笔策略盈亏图（悬停查看任意标的价格下的盈亏）。
- **完全本地**：行情缓存与持仓均存于本地，不依赖任何云服务或外部数据库。

## 🚀 快速开始

### 环境要求
- Python 3.8+

### 运行
```bash
cd option_calculator
python app.py
# 可选：自定义监听端口与地址
PORT=8765 HOST=0.0.0.0 python app.py
```
启动后访问：http://localhost:8765

### 操作指引
1. **行情看板**：选择标的与到期月份；点击任意「最新价」录入持仓；点击价格右上角的 `∑` 弹出快速收益试算。
2. **我的持仓**：右上角「+ 新增持仓」手动录入，持仓列表支持编辑 / 部分平仓 / 删除。
3. **收益分析**：自动按最新行情逐腿盯市，展示组合盈亏曲线与各持仓盈亏贡献。
4. **快速试算**：选择合约（或从行情带入），调整开仓 / 平仓权利金与张数，实时查看收益与盈亏图。

## 📁 目录结构
```
option_calculator/
├── app.py                      # 零依赖 Web 服务（路由 + API）
├── quotes.py                   # 东方财富行情网关
├── analytics.py                # BS 定价、IV/Greeks 反推、曲线计算
├── storage.py                  # SQLite 持仓存储
├── data/                       # 本地数据库（已 git 忽略）
├── web/                        # 应用前端（依赖后端 API）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── docs/index.html             # GitHub Pages 静态落地页
├── .gitignore
├── README.md
└── .github/workflows/pages.yml # GitHub Pages 部署
```

## 🔌 API 说明
所有接口返回 JSON，行情接口前缀 `/api/`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/market` | 标的基础信息（名称、代码等） |
| GET | `/api/quotes?underlying=&expiry=` | 指定标的与到期月的合约行情 |
| GET | `/api/contracts?q=` | 按代码 / 名称搜索合约 |
| GET | `/api/portfolio` | 组合汇总（持仓、浮动 / 已实现盈亏、保证金等） |
| GET / POST | `/api/positions` | 获取 / 新增持仓 |
| PUT / DELETE | `/api/positions/{id}` | 修改 / 删除持仓 |
| POST | `/api/positions/{id}/close` | 部分 / 全部平仓 |
| GET / DELETE | `/api/closes[/id]` | 平仓记录查询 / 撤销 |
| POST | `/api/simulate` | 单笔收益试算（含盈亏曲线） |
| POST | `/api/refresh` | 强制刷新行情缓存 |

## 🌐 部署

### 自托管（推荐，全功能）
直接在服务器运行 `python app.py` 即可，前端默认同源请求 `/api/`，无需额外配置。若前后端分离部署，可在 `web/index.html` 顶部设置 `window.__API_BASE__` 指向后端地址。

### GitHub Pages（静态落地页）
`.github/workflows/pages.yml` 会把 `docs/`（纯静态项目介绍页）部署到 GitHub Pages。推送到 `main` 分支后，在仓库 **Settings → Pages → Build and deployment** 选择 **GitHub Actions** 即可。

> ⚠️ Pages 站点**只是介绍页**：不加载应用本体、不请求任何行情接口。应用依赖 Python 后端（行情抓取、BS 定价、保证金计算、SQLite 持仓），GitHub Pages 无法运行后端，因此真正使用功能请本地执行 `python app.py`，或把整套服务部署到自有服务器。

## ⚠️ 免责声明
- 行情数据来自第三方公开接口，可能存在延迟、缺失或错误，请以券商终端为准。
- IV 与 Greeks 基于 Black-Scholes 欧式模型估算（无风险利率 1.8%、无分红）；A 股 ETF 期权为美式行权，估算值仅供研究参考。
- 保证金按交易所公式估算，实际以券商结算为准。
- 本工具仅供学习与策略研究，**不构成投资建议**，使用风险自负。
