# 版权、来源与设计参考

许可证全文与原始通知存放于 `LICENSES_CREDITS/`。具体文件、是否入包、权利覆盖及迁移状态见 [`source-provenance.json`](LICENSES_CREDITS/source-provenance.json)。本文件保留来源致谢，同时修正把“已集成”“计划使用”“只参考思路”混写的旧描述；不因此删除有效原始通知。

原作者支持交接及 Apache-2.0／MIT 迁移是已确认事实。当前根许可仍为 GPLv3；首选迁移目标 Apache-2.0，MIT 备选。原作者有权重新许可的原创代码无需因历史 GPL 声明重写。第三方来源及贡献覆盖仍按具体范围记录，见 [迁移说明](docs/LICENSE-MIGRATION.md)。

## GPL 来源：首批处理与后续任务

### cat-catch（猫抓）

- 原作者：xifangczy 及 cat-catch 贡献者。
- 来源：https://github.com/xifangczy/cat-catch ，当前登记副本版本 2.6.9，GPL-3.0。
- 原范围：`src/download_service/` 的浏览器扩展源码与 Reverie Electron 适配器。旧 README 将整个服务描述为完整 m3u8/mpd 下载能力，不能据此推定所有功能实际可用。
- 本轮状态：当前可达的有限 IPC 能力已由第一方媒体服务实现并通过契约测试，整个旧树已从当前工作树删除；新包验收另行登记。来源、版本、删除提交和验收分别登记；保留原 GPL 文本及 metadata-only 文件清单作为历史记录。
- `src/video_download/` 是独立的 Python 聊天视频入口；其文件头声明不共享运行代码但引用旧适配器结构，另行核对来源，不随旧目录一起删除。

### Kazumi

- 原作者：Predidit 及 Kazumi 贡献者。
- 来源：https://github.com/Predidit/Kazumi ，登记版本 2.1.7+20107，GPL-3.0。
- 原范围：`src/anime_service/` 的未集成工程。原生产 staging 已排除；本次没有定位到已集成运行调用，不应描述为已经提供 XPath、Anime4K 或共同追番功能。
- 本轮决定：移除未集成树，保留原许可、文件摘要清单和删除提交记录，不误删第一方 `affairs`，不新建完整追番替代栈。

### Risuai

- 原作者：Kwaroran（既有版权记录：Copyright 2024）及 Risuai 贡献者。
- 来源：https://github.com/kwaroran/Risuai ，GPL-3.0。
- 历史范围：旧 `src/lorebook/` 与 `src/memory/hypa_v3.py` 已删除，元数据清单分别保留于 `LICENSES_CREDITS/history/risu-worldbook-files.json`、`risu-hypa-files.json`，原 GPL 来源与版权通知继续保留。
- 当前独立实现：世界书见 [第二阶段记录](docs/LICENSE-MIGRATION-STAGE-TWO.md)，对话摘要见 [摘要契约](docs/CONVERSATION-SUMMARY.md)。删除两个来源不代表其他 GPL 依赖或整体许可迁移已经完成。
- 当前桌面壳仍是 Electron。旧致谢中“Tauri 替代 Electron”以及上游所有 Emotion Images／Regex 能力均已落地的含义不成立。
- 独立摘要及旧数据隔离导入已完成限定核心验收；导入记录保持 inactive，原始来源和历史通知继续保留，见第四阶段记录。

### elephantops（历史运行依赖，第四阶段已退役）

- 原作者：Luca Ferranti、Niklas Fiekas（original chessops），按已安装包作者字段记录。
- 来源：https://github.com/lucaferranti/elephantops ，历史锁定／安装版本 0.1.1，声明 GPL-3.0-or-later，包中保留 GPLv3 LICENSE 正文。
- 历史范围：旧 `MiniGamePanel.tsx` 导入象棋规则与坐标工具；旧 Windows installer 保留其对应源码。第四阶段已移除实际导入及专用源码拷贝路径。
- 当前结论：独立规则保留原棋谱契约，elephantops 及唯一专属传递依赖已从当前生产图退役。保留旧版权和来源记录；不重开已完成替换，不将这一项关闭推导为整体改证完成。

### NachoBot（历史记录）

既有致谢记录 NachoBot 贡献者、GPLv3，以及 https://github.com/NachoBot/NachoBot 的来源地址；其他旧文档出现不同仓库地址，来源版本尚未核定。本次未定位到当前集成的 NachoBot 源码或已实现 QQ 适配，不把许可文本的存在当作实际运行证据。GPL 原文作为历史记录保留；AGPL 排除项见 `AGPL_EXCLUDED.md`。

## 保留的 Apache-2.0／MIT 来源

### N.E.K.O（Apache-2.0）

原作者：Project N.E.K.O. Team（Copyright 2025-2026）及 Hongzhi Wen（Copyright 2025）。来源：https://github.com/Project-N-E-K-O/N.E.K.O 。

`src/memory/neko_import.py` 与 `src/bridge/memory_bridge.py` 的文件头明确声明从上游提取逻辑并由 Muhe Studio 修改，因此不能将 N.E.K.O 全部分类为“只借鉴思路”。TTS 文件也存在设计来源声明。保留原版权、修改说明、Apache-2.0 全文及完整原 `NOTICE-NEKO.txt`；根 NOTICE 内原通知继续保留。为自主维护进行重写可另行安排，不是迁移前置要求。

### Project AIRI（MIT）

原作者：Neko Ayaka（Copyright 2024-PRESENT）及 moeru-ai 贡献者。来源：https://github.com/moeru-ai/airi 。

`frontend/src/components/AvatarView/Live2DAdapter.tsx` 明确声明从 AIRI 的 Canvas.vue／Model.vue 提取并适配渲染逻辑；`src/tts/workers/gemini.py` 则声明参考语音协议且代码原创，不能因此认定它复制了实现。两种证据按文件区分；渲染适配器继续保留 MIT 通知。排除的上游 AGPL 夹具不在此授予许可范围内。

### pixi-live2d-display 0.4.0（MIT）

原作者：guansss／Guan（Copyright 2020）及贡献者。来源：https://github.com/guansss/pixi-live2d-display 。

`frontend/vendor/pixi-live2d-display` 保留 Cubism 4 所需构建与类型，原包中的文档发布依赖 `gh-pages` 不作为生产依赖。保留 vendor 目录 LICENSE 与镜像 MIT 文本。该许可证不包含 Live2D Cubism Core。

### foxgirls.club（MIT）

原作者：foxgirls.org（Copyright 2026）。来源：https://github.com/foxgirlsorg/foxgirls.club 。

`src/image_service/` 明确声明 vendored 服务和 Reverie 包装，并包含上游网页／索引相关文件；不应将整个子树称为仅思想参考。保留 MIT 文本。软件许可不证明所引用图片内容的版权归属或适用范围。

### 来源范围仍需细化的宽松项目

| 项目与原作者 | 现有记录与决定 |
| --- | --- |
| [Luna-ts](https://github.com/Alan-Yu-2077/Luna-ts)，Alan-Yu-2077 及贡献者（Copyright 2026），MIT | 既有记录包含视线适配、拖拽、重连、语音和供应流程参考。当前说明存在“适配”与“思路”差异，逐文件核对；保留许可，不能据名称断言复制或完全独立。Cubism Core 不在 MIT 范围 |
| [OpenRoom](https://github.com/MiniMax-AI/OpenRoom)，MiniMax（Copyright 2025-2026），MIT | 桌面房间和应用形态参考；本次未确立具体复制文件。保留历史通知并核对来源，不宣称已移植上游全部应用能力 |
| [liquidglass-oss](https://github.com/ogtirth/LiquidGlass-OSS)，Liquid Glass OSS contributors（Copyright 2026），MIT | CSS／组件头部声明玻璃拟态视觉参考；保留通知，具体复制范围不由本次分类推定 |

## 运行依赖

| 组件 | 作者／来源／许可 | 使用范围 |
| --- | --- | --- |
| sqlite-vec | Alex Garcia（Copyright 2024）及贡献者；https://github.com/asg017/sqlite-vec ；MIT OR Apache-2.0，Reverie 发行按 MIT | 本机世界状态库的可重建向量索引扩展 |
| ddgs | deedy5 及贡献者；https://github.com/deedy5/ddgs ；MIT | 免 Key 搜索后端，按现有锁固定版本 |
| primp | https://github.com/deedy5/primp ；MIT | ddgs 的传递 HTTP 依赖，其 TLS/浏览器请求行为由上游控制；Reverie 自有 HTTP 请求仍使用自身 UA 策略 |
| trafilatura／courlan／htmldate | https://github.com/adbar/trafilatura ；Apache-2.0 | 网页正文抽取，缺失时使用既有内置降级 |
| click／lxml／lxml-html-clean／charset-normalizer／justext／babel／dateparser 等 | 按实际安装包各自许可证 | 传递依赖，以锁文件、包元数据及本次构建生成的许可清单为准 |

此表所列宽松依赖可以合规保留，不全部列为改换宿主许可的前置重写事项。`elephantops` 是历史确认并已退役的 GPL 依赖；第四阶段最终元数据图为14个直接依赖／98个实例，元数据结论不代表全部源码及资产许可完成。保留现有版本及哈希，不以迁移为由自动升级。

## 公开格式和设计参考

以下是现有实现的参考声明，与上面的实际 vendored／改编来源分别登记；本轮未作覆盖全树的独立实现认证。

- [Character Card V2](https://github.com/malfoyslastname/character-card-spec-v2)、[V3 草案](https://github.com/kwaroran/character-card-spec-v3)及 [PNG 规格](https://www.w3.org/TR/png/)：角色卡／世界书字段、PNG `chara`／`ccv3` 块兼容。
- [SillyTavern](https://github.com/SillyTavern/SillyTavern)（Cohee 及贡献者，AGPL-3.0）：现有声明仅用于公开格式兼容，不将其软件许可证自动扩展为 Reverie 对源码的使用许可。
- [ALTM](https://github.com/cuiyuestar/Autonomous-Long-Term-Memory-System)、[Mem0](https://github.com/mem0ai/mem0)、[Letta / MemGPT](https://github.com/letta-ai/letta)（既有记录均为 Apache-2.0）：记忆层级、评分、证据链、实体关联、离线整理等架构参考。
- HippoRAG／HippoRAG 2、A-MEM、Generative Agents、LongMemEval：联想检索、结构化记忆、评分和评测思想参考。
- [deepseek_v4_rolepaly_instruct](https://github.com/victorchen96/deepseek_v4_rolepaly_instruct)，victorchen96 及贡献者：角色沉浸／分析模式的提示设计资料，单独记录为文档参考。
- KnockOutEZ/wigolo（AGPL-3.0-only）：既有声明为联网搜索架构灵感；代码排除范围见 `AGPL_EXCLUDED.md`。不把“参考”标签当作来源审查的替代。

## 单独适用的服务、运行时与资产条款

- Google Places API (New)：用户自带 Key；服务结果按 Google Maps Platform 条款、适用政策及署名要求处理。条款：https://cloud.google.com/maps-platform/terms ，隐私：https://policies.google.com/privacy 。
- Live2D Cubism Core：Live2D Inc. 专有运行时，维持现有出版许可检查；公开 Core 构建不附带用户角色模型，核心 macOS 测试构建的实际内容以产物清单为准。
- 用户导入 Live2D 模型、声音权重和角色资产：不因运行于 Reverie 或宿主许可迁移改变权利归属。开发夹具路径不得进入公开包。
- 随包声音与角色：保留 `FOCUS-SOUNDS-NOTICE.txt`、`YUMI-ASSET-NOTICE.txt`、`YUMI_CHARACTER_RIGHTS.json` 和 `frontend/src/assets/dreamroom/LICENSES.md`，按实际内容核验。

## 排除范围与历史保留

既有 AGPL 排除项记录在 [`AGPL_EXCLUDED.md`](AGPL_EXCLUDED.md)，包括 NachoBot 相关插件／子树、AIRI 上游特定测试夹具和 wigolo 源码。该清单是一项具体范围声明，不构成对未知来源的保证，也不应用来推论模块隔离自动免除许可要求。

首批移除后继续保留 Kazumi、cat-catch 等许可证原文和文件摘要记录，是为了历史可追溯；当前实际包含范围由来源登记与新构建清单共同确定。正式迁移前重新核对完整代码树、贡献范围和新产物，再同步根许可、贡献规则和分发通知。

更新：2026-10-05；原始来源通知保持原权利人名称与版权行。

### elephantops 退役

原依赖 `elephantops@0.1.1`（Luca Ferranti、Niklas Fiekas／original chessops，GPL-3.0-or-later）已由独立象棋模块替换。历史文件摘要和公共 API 行为契约保留于 `LICENSES_CREDITS/history/elephantops-*.json`。新版不携带该依赖源码；完整候选验收及未覆盖许可事项见 `docs/STAGE-FOUR-MIGRATION.md`。历史通知不是当前源码并入声明。
