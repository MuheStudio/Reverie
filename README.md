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

**当前单机客户端整体仍以 GNU GPLv3 开源。** 许可证全文见 [`LICENSE`](LICENSE)。原作者已支持交接与宽松许可迁移；目标优先 Apache-2.0，MIT 为备选，不自动双许可。正式切换须完成具体来源和授权覆盖核验，见 [许可迁移记录](docs/LICENSE-MIGRATION.md)。

Apache-2.0 上游的通知合并在 [`NOTICE`](NOTICE)。第三方许可证原件在 [`LICENSES_CREDITS/`](LICENSES_CREDITS/)，逐项说明在 [`CREDITS.md`](CREDITS.md)。AGPL 组件的排除清单见 [`AGPL_EXCLUDED.md`](AGPL_EXCLUDED.md)。

预留的云端接口（备份、算力托管、联机）是独立的商业服务，**不在 GPLv3 源码范围内**。单机必须在完全离线、只用用户自己的 API Key 或 Ollama 时可用。

## 来源致谢：代码、依赖与参考

Reverie 由 [hoshinohatsuka](https://github.com/hoshinohatsuka)发起，现由获交接支持的维护者继续开发。下表区分当前源码证据与历史参考；不能仅凭“借鉴”一词判断是否并入第三方实现。详细路径、处理状态和验收见 [`source-provenance.json`](LICENSES_CREDITS/source-provenance.json) 和 [`CREDITS.md`](CREDITS.md)。

### 当前保留与已移除的来源组件

| 项目 | 许可证 | 范围与处理 |
| --- | --- | --- |
| [cat-catch](https://github.com/xifangczy/cat-catch) | GPL-3.0 | 旧 `src/download_service/` 已移除，现有有限下载 IPC 改用第一方媒体服务；保留历史来源，新包验收状态见迁移登记 |
| [Kazumi](https://github.com/Predidit/Kazumi) | GPL-3.0 | 旧 `src/anime_service/` 是未集成工程，原生产 staging 已排除；已在本地首批提交 `e84c994` 移除，不作为可用追番功能 |
| [Risuai](https://github.com/kwaroran/Risuai) | GPL-3.0 | 旧世界书与 Hypa 源码已分别由独立世界书、对话摘要模块替换；历史来源记录保留，当前摘要边界与验收见 `docs/CONVERSATION-SUMMARY.md` |
| [elephantops](https://github.com/lucaferranti/elephantops) 0.1.1 | GPL-3.0-or-later | 历史象棋依赖已由独立90格引擎替换，已从锁、生产图和新应用退役；见第四阶段验收 |
| [N.E.K.O](https://github.com/Project-N-E-K-O/N.E.K.O) | Apache-2.0 | 记忆导入与互操作桥声明提取及修改了上游逻辑；保留原 NOTICE 和修改说明，不统称仅思想参考 |
| [Project AIRI](https://github.com/moeru-ai/airi) | MIT | Live2DAdapter 声明由 AIRI 组件改编；保留版权和许可 |
| [foxgirls.club](https://github.com/foxgirlsorg/foxgirls.club) | MIT | `src/image_service/` 为 vendored 服务及包装；图片版权另论 |
| [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) 0.4.0 | MIT | `frontend/vendor/pixi-live2d-display` 保留 Cubism 4 所需运行文件；合规保留，不属于必须重写项 |

Python 聊天视频链路 `src/video_download/` 与 Electron 下载服务分离，现有头部声明独立实现但引用旧适配器结构。本轮保留功能并单独核对来源，不仅凭“运行时未共享代码”认定审查完成。

### 合规保留的运行依赖

| 项目 | 许可证 | 用途 |
| --- | --- | --- |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | MIT OR Apache-2.0 | 发行包按 MIT 保留通知，本机向量索引 |
| [ddgs](https://github.com/deedy5/ddgs) / [primp](https://github.com/deedy5/primp) | MIT | 搜索的直接／传递依赖，版本和哈希见运行锁文件 |
| [trafilatura](https://github.com/adbar/trafilatura) / courlan / htmldate | Apache-2.0 | 网页正文抽取；保留许可证及适用通知 |

### 参考声明与待核对来源

Luna-ts、OpenRoom 与 liquidglass 的既有文字在“适配”和“灵感”分类上不一致，现保留通知并逐文件核对，不把所有相关功能都宣称为源码复用或独立重写。NachoBot 保留历史致谢；本次未定位到当前集成源码，不代表 QQ 适配已完成。

Character Card V2/V3、PNG、SillyTavern 格式、ALTM、Mem0、Letta/MemGPT 与记忆论文继续作为已有格式／设计参考登记；具体资料和原声明见 CREDITS。这些声明不构成对整个代码树的独立实现保证。

Reverie 兼容酒馆角色卡与世界书；产品仍有未完成和未充分验证的功能，来源表不代表对应上游的全部能力已经移植。

**Live2D Cubism Core** 由 Live2D Inc. 单独许可，不属于 MIT 或宿主许可。保持现有出版门禁；用户模型、声音、角色与其他资产权利单独登记，不随宿主改许可自动改变。

## 用户：安装发行版

双击安装 [`Reverie0.5.5-Setup-0.5.5-x64.exe`](https://github.com/Muhe-Studio/Reverie/releases)默认装到 `C:\Program Files\Reverie`。第一次打开走新手引导：填 API、导入你自己的 Live2D、可选导入角色卡/世界书。卸载或重装不应抹掉 `%APPDATA%` 里已有的记忆和日记。

## 二次开发

macOS Apple Silicon 开发环境使用项目内固定工具链：先运行 `./script/setup-macos.sh`，
再运行 `./script/check-macos.sh` 验收，使用 `./script/dev-macos.sh` 启动。
详见 [macOS 开发环境说明](docs/MACOS-DEVELOPMENT.md)。该流程用于源码运行。

独立 macOS arm64 核心测试应用使用 `./script/package-macos.sh` 构建，
以 `./script/check-macos-package.sh` 验证；详见 [macOS 打包说明](docs/MACOS-PACKAGING.md)。
当前产物采用本地测试签名，不是正式分发或公证安装包。

已验收的应用可用 `./script/package-macos-dmg.sh` 封装为测试 DMG，
再用 `./script/check-macos-dmg.sh` 验证镜像内启动及复制、推出镜像后的重启恢复。
本轮结果见 [macOS 测试 DMG 验收摘要](docs/MACOS-ACCEPTANCE.md)。

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
