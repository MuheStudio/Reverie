# Reverie（幻梦）

> **任何人都可以拥有自己的数字人格伴侣，但没有人能把社区贡献据为己有然后关门收费。**
>
> — 沐禾工作室 / Muhe Studio

Reverie 是本地优先的 AI 数字人格伴侣。TA不是一轮一轮的聊天机器人：她有记忆、情绪、作息、日记、朋友圈和主动找你的理由。

当前公开版本是 **Windows 0.5.5**。Live2D **不随包装模型**：安装器只带 Cubism Core；形象由用户在新手引导里自己导入 `*.model3.json` 文件夹 / zip。

## Reverie中的伴侣应该是什么样

- 像人一样说话：回复有短有长，不会秒回，会分段发，有口癖，偶尔会打错字或撤回
- 记得你：跨会话长期记忆；会遗忘、会记错，但姓名/生日等身份锚点受保护
- 有情绪：八维情绪（开心、平静、兴奋、失落、生气、紧张、委屈、感动）有惯性，会写进日记和朋友圈
- 有生活：作息、熬夜、加密日记、朋友圈、社交圈
- 会主动：按时间、事件、情绪、记忆找你，而不是永远等你先开口
- 本地优先：记忆、日记、密钥、聊天都在本机；云备份接口标「开发中」，不是使用前提
- 开箱即用：普通用户不需要安装 Python / Node / FFmpeg / Conda

TA不会主动声称自己是人工智能。只有用户直接追问身份时，才给一句诚实的短披露。

## 现在已经能做什么（Windows 0.5.5）

对照计划清单的实现：

| 能力 | 用户能看到的结果 |
|---|---|
| 新手引导 | 第一次启动出现；Live2D / 角色卡 / 世界书 / API 密钥可在引导里完成 |
| Live2D | 用户导入模型；全应用共用一套形象；换角色卡只换人设，不换形象 |
| 聊天 | MVP 房间 + TA的房间 + 桌宠；草稿会留；错误原文可见，可复制 |
| 角色卡 / 世界书 | 导入 SillyTavern PNG/JSON 角色卡与独立 `world_info.json`；可导出 |
| 记忆 | SQLite 为真相源；检索会参考实体共现和时序意图；治理开关可关可存 |
| 视频 | 免责声明默认关；同意后可贴公开 mp4/m3u8，聊天里出现一条可点播视频 |
| 免 Key 搜索 | 引导勾选冲浪免责后，时段内回复可带引用；不勾则不搜 |
| 语音 | 未配 GPT-SoVITS 时用浏览器朗读兜底；可导入语音包 |
| 备份 | JSON 备份导入导出，不覆盖安装器自带的空种子去抹掉用户数据 |

明确还没做完、不要当成已发布能力：官方云备份/算力、安卓 / Linux 安装器、内置 chub 爬虫、随包 ffmpeg、商业 DRM 破解、把第三方样例卡打进安装器。

## 开源协议

**单机客户端整体以 GNU GPLv3 开源。** 许可证全文见 [`LICENSE`](LICENSE)。

Apache-2.0 上游的通知合并在 [`NOTICE`](NOTICE)。第三方许可证原件在 [`LICENSES_CREDITS/`](LICENSES_CREDITS/)，逐项说明在 [`CREDITS.md`](CREDITS.md)。AGPL 组件的排除清单见 [`AGPL_EXCLUDED.md`](AGPL_EXCLUDED.md)。

预留的云端接口（备份、算力托管、联机）是独立的商业服务，**不在 GPLv3 源码范围内**。单机必须在完全离线、只用用户自己的 API Key 或 Ollama 时可用。

## 借鉴致谢：代码 vs 思路

Reverie 是[hoshinohatsuka](https://github.com/hoshinohatsuka)的第一个大项目。所以借鉴了许多优质开源项目。下表是对用户、对原作者都该看清的边界：**「借鉴了代码」** 表示运行时里有该项目的源码、移植或 vendored 副本；**「借鉴了思路」** 表示只读公开规格 / 论文 / 架构，Reverie 侧是洁室重写，没有拷他们的源文件。

### 借鉴了代码

| 项目 | 许可证 | Reverie 里实际落了什么 |
|---|---|---|
| [cat-catch（猫抓）](https://github.com/xifangczy/cat-catch) | GPL-3.0 | `src/download_service/` 为 vendored 适配；Electron 侧 `sniff:*` / `download:*` IPC。聊天用的 HLS 解析与合并是 Reverie 自写的 `src/video_download/`，不跑猫抓的外部 ffmpeg 服务器 |
| [Risuai](https://github.com/kwaroran/Risuai) | GPL-3.0 | 世界书匹配思路与 HypaMemory V3 压缩流程按 GPL 在 Python 侧重写：`src/lorebook/`、`src/memory/hypa_v3.py`（文件头保留原作者与许可证） |
| [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) 0.4.0 | MIT | `frontend/vendor/pixi-live2d-display`，只留 Cubism 4 运行所需文件 |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | MIT OR Apache-2.0 | 发行包按 MIT 分发，作为本机向量索引扩展 |
| [ddgs](https://github.com/deedy5/ddgs) + [primp](https://github.com/deedy5/primp) | MIT | 免 Key 搜索的直接/传递依赖，哈希锁在 `requirements-runtime.lock` |
| [trafilatura](https://github.com/adbar/trafilatura) / courlan / htmldate | Apache-2.0 | 网页正文抽取；缺库时降级为内置剥标签 |

N.E.K.O（Apache-2.0）在 NOTICE 中按协议保留了原 NOTICE 全文。若某份源文件是从 Apache-2.0 树改过来的，文件头会有 Muhe Studio 的修改说明。

### 借鉴了思路（洁室，未拷源码）

| 项目 | 许可证 | 借了什么，没借什么 |
|---|---|---|
| [N.E.K.O](https://github.com/Project-N-E-K-O/N.E.K.O) | Apache-2.0 | 五维记忆、主动陪伴、本地人格伴侣的产品形状 |
| [Project AIRI](https://github.com/moeru-ai/airi) | MIT | VRM/Live2D 作为可见形象、多 LLM 提供商、语音管道的产品形状 |
| [OpenRoom / VibeApps](https://github.com/MiniMax-AI/OpenRoom) | MIT | 桌面房间、日记/音乐等「她也有自己的应用」的骨架思路 |
| [Luna](https://github.com/Alan-Yu-2077/Luna) | MIT（Cubism Core 除外） | 头部中心、按距离缩放的鼠标视线；Cubism Core 本身是 Live2D Inc. 专有文件，不进 git |
| [SillyTavern](https://github.com/SillyTavern/SillyTavern) | AGPL-3.0 | **只**参考并兼容公开的 Character Card V2 / 世界书 JSON 。不拷 `.js`，不使用源代码。|
| [Character Card V2](https://github.com/malfoyslastname/character-card-spec-v2) / [V3 草案](https://github.com/kwaroran/character-card-spec-v3) | 开放规格 | `chara` / `ccv3` PNG 块、`character_book.entries` 字段名 |
| [ALTM](https://github.com/cuiyuestar/Autonomous-Long-Term-Memory-System) | Apache-2.0 | 驻留/查询分、预算压力、引用反馈、证据链、折叠 worker |
| [Mem0](https://github.com/mem0ai/mem0) | Apache-2.0 | 轻量实体共现、检索时解冲突 |
| [Letta / MemGPT](https://github.com/letta-ai/letta) | Apache-2.0 | 分层记忆、空闲期离线整理 |
| HippoRAG / A-MEM / Generative Agents / LongMemEval | 论文 | 联想检索、原子笔记、recency+importance+relevance、评测口径 |
| [Kazumi](https://github.com/Predidit/Kazumi) | GPL-3.0 | 一起追番 / 规则引擎的产品方向（完整追番栈未作为本版卖点，请等待后续更新） |
| [NachoBot]((https://github.com/Big-Sh0t114/NachoBot)) | GPLv3 | 多平台适配的远期方向；其 AGPL 插件子树已排除 |
| [foxgirls.club](https://github.com/foxgirlsorg/foxgirls.club) | MIT | 随机二次元图的情绪价值 |
| liquidglass-oss | MIT | 玻璃拟态 CSS 观感 |
| wigolo | AGPL-3.0 | **仅**联网搜索架构灵感；代码零并入 |

目前Reverie向上兼容酒馆（[SillyTavern](https://github.com/SillyTavern/SillyTavern)）的角色卡与世界书，此为核心聊天功能，可正常运行，为了保证开箱即用，Reverie内置了星野幻月角色（是[hoshinohatsuka](https://github.com/hoshinohatsuka)的OC）。

但实际上上述某些功能并未真正能正常运行，因为时至今日，Reverie仍然是半成品。请等待后续更新。

**一句话：Reverie是吃百家饭长大的**

**Live2D Inc. Cubism Core** 不是开源项目。公开安装器只分发持有出版许可的 `Live2DCubismCore.js`，不附带任何 `.moc3` / 纹理 / 动作。用户导入的模型版权归模型作者。

**不会并入：** 任何商业 DRM 破解。

## 用户：安装发行版

双击安装 [`Reverie0.5.5-Setup-0.5.5-x64.exe`](https://github.com/Muhe-Studio/Reverie/releases)默认装到 `C:\Program Files\Reverie`。第一次打开走新手引导：填 API、导入你自己的 Live2D、可选导入角色卡/世界书。卸载或重装不应抹掉 `%APPDATA%` 里已有的记忆和日记。

## 二次开发

欢迎大家对本项目做贡献， Reverie 本身是纯 Vibe coding 出来的。

若用 Vibe coding 方式为本项目做贡献，建议本地克隆仓库后安装并启用[hoshinohatsuka](https://github.com/hoshinohatsuka)开发的一个Skill，可让AI快速了解本项目并准备接手。即[项目接手.Skill](https://github.com/hoshinohatsuka/project-relay-Skill)。建议使用模式A。

若准备以古法编程对本项目做贡献也热烈欢迎，请参照下述方法。

需要 Python 3.12、Node.js 18+、pnpm、Git。不要把用户数据写到别人的 `测试\` 目录。

```powershell
git clone https://github.com/Muhe-Studio/Reverie.git
cd Reverie/Reverie-project/Reverie-Windows   # 若仓库根就是本目录，则 cd 到仓库根

python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements-runtime.txt
pip install -r requirements-dev.txt

cd frontend
pnpm install
pnpm dev
```

另开终端跑 Python 桥接（或使用 Electron 桌面入口 `pnpm electron:dev`）。测试：

```powershell
# 在 Reverie-Windows 根
.\venv\Scripts\python.exe -m pytest tests -q
cd frontend
npx vitest run
node script/test-mvp.cjs
```

公开安装器构建（Cubism Core-only，禁止打进角色模型）：

```powershell
$env:REVERIE_LIVE2D_PUBLIC_BUILD = "1"
$env:REVERIE_LIVE2D_CORE_PATH = "H:\path\to\Live2DCubismCore.js"
$env:REVERIE_BUILD_PYTHON = "H:\path\to\python.exe"   # 3.12，且能 import PIL
pnpm package:win
```

细节见 [`frontend/WINDOWS-PACKAGING.md`](frontend/WINDOWS-PACKAGING.md)。


## 项目结构

```
Reverie-Windows/
├── LICENSE / NOTICE / CREDITS.md / AGPL_EXCLUDED.md
├── LICENSES_CREDITS/     上游许可证原件
├── src/                  Python 本地服务（记忆、聊天、世界书、视频下载门）
├── frontend/             Electron + React（MVP 房间、她的房间、桌宠、引导）
├── tests/                pytest
└── config/               protocol-v4 契约
```
## 致谢

[Darkline](https://github.com/muyuzy123-pixel) ：提供精神支持及帮助制作Live 2D模型。

---

*© 2026 沐禾工作室 / Muhe Studio*
