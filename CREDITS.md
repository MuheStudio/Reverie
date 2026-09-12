# 版权归属与开源痕迹 (Licenses & Credits)

> 本文件记录 Reverie 所借鉴的全部开源项目的原始作者版权声明。
> 原始许可证全文存放在 `LICENSES_CREDITS/` 目录中。

---

## GNU General Public License v3.0 (GPL-3.0)

### cat-catch（猫抓）— 资源嗅探浏览器扩展
- **原作者**: xifangczy 及 cat-catch 贡献者
- **原始仓库**: https://github.com/xifangczy/cat-catch
- **许可证**: GPL-3.0（1.0 版为 MIT，2.0 版起更改为 GPLv3）
- **在 Reverie 中的角色**: 编译为内置网络下载功能，提供 m3u8/mpd 资源嗅探与下载能力

### Kazumi — 番剧采集与在线观看程序
- **原作者**: Predidit 及 Kazumi 贡献者
- **原始仓库**: https://github.com/Predidit/Kazumi
- **许可证**: GPL-3.0
- **在 Reverie 中的角色**: XPath 规则引擎、Anime4K 超分辨率、与虚拟伴侣一起追番

### NachoBot — 多平台 AI 虚拟生命框架
- **原作者**: NachoBot 贡献者
- **原始仓库**: https://github.com/NachoBot/NachoBot
- **许可证**: GPLv3（注意：部分插件子模块为 AGPL-3.0，已被排除不使用）
- **在 Reverie 中的角色**: QQ 聊天适配（最后阶段实现）

---

## Apache License 2.0

### N.E.K.O — 网络型情感知性生命体（猫娘计划）
- **原作者**: Project N.E.K.O. Team (Copyright 2025-2026)
- **原始仓库**: https://github.com/Project-N-E-K-O/N.E.K.O
- **许可证**: Apache 2.0
- **在 Reverie 中的角色**: 五维记忆系统、主动陪伴、实时语音对话、Agent 工具执行
- **NOTICE 原文**: 「我们种下了人与猫娘幸福共生的种子，我们的征途是星辰大海。」—— Project N.E.K.O. Team

---

## MIT License

### Project AIRI — AI VTuber 灵魂容器
- **原作者**: Neko Ayaka (Copyright 2024-PRESENT) 及 moeru-ai 贡献者
- **原始仓库**: https://github.com/moeru-ai/airi
- **许可证**: MIT
- **在 Reverie 中的角色**: VRM/Live2D 虚拟形象、语音输入输出、多 LLM 提供商适配

### Luna-ts — Live2D AI 陪伴应用
- **原作者**: Alan-Yu-2077 及 Luna-ts 贡献者 (Copyright 2026)
- **原始仓库**: 用户提供的本地 `Cloning-project/Luna-ts`
- **许可证**: MIT（其携带的 Live2D Cubism Core 不属于 MIT）
- **在 Reverie 中的角色**: 参考并适配头部中心、按距离缩放的鼠标视线跟随算法；本机开发辅助脚本可从该检出目录暂存 Cubism Core
- **Core 边界**: `Live2DCubismCore.js` 是 Live2D Inc. 软件，不属于 Luna-ts 的 MIT 许可或 Reverie 的 GPL-3.0 源码；开发副本只进入 gitignored 的 `frontend/.runtime-cache`
- **发布门禁**: 公开构建仅从 `REVERIE_LIVE2D_CORE_PATH` 暂存 Core，并要求当前有效的 Live2D 应用出版许可证；缺失、失效或占位许可均拒绝打包

### pixi-live2d-display — Cubism 4 Web 渲染运行时
- **原作者**: guansss 及 pixi-live2d-display 贡献者
- **上游版本**: 0.4.0（MIT）
- **使用范围**: `frontend/vendor/pixi-live2d-display` 只保留 Cubism 4 运行所需构建与类型；删除上游误列为生产依赖、但仅用于发布文档的 `gh-pages`
- **许可证**: MIT（镜像全文见 `LICENSES_CREDITS/LICENSE-MIT-pixi-live2d-display.txt`）；随本地运行时镜像保留 `frontend/vendor/pixi-live2d-display/LICENSE`

### foxgirls.club — 随机狐娘图片服务
- **原作者**: foxgirls.org (Copyright 2026)
- **原始仓库**: https://github.com/foxgirlsorg/foxgirls.club
- **许可证**: MIT
- **在 Reverie 中的角色**: 随机狐娘图片获取（SFW/NSFW 可选），情绪价值

### OpenRoom (VibeApps) — 浏览器 AI 桌面
- **原作者**: MiniMax (Copyright 2025-2026)
- **原始仓库**: https://github.com/MiniMax-AI/OpenRoom
- **许可证**: MIT
- **在 Reverie 中的角色**: 桌面环境骨架、日记应用、音乐播放器、AI Agent 应用操作

### sqlite-vec — SQLite 向量检索扩展
- **原作者**: Alex Garcia (Copyright 2024) 及 sqlite-vec 贡献者
- **原始仓库**: https://github.com/asg017/sqlite-vec
- **许可证**: MIT OR Apache-2.0（Reverie 发行包按 MIT 条款分发）
- **在 Reverie 中的角色**: 同一 SQLite 世界状态库内的可重建本地向量索引

---

### Risuai — 跨平台 AI 聊天软件
- **原作者**: Kwaroran (Copyright 2024)
- **原始仓库**: https://github.com/kwaroran/Risuai
- **许可证**: GPL-3.0
- **在 Reverie 中的角色**: Tauri 桌面壳（替代 Electron）、Lorebook 世界书、HypaMemory 记忆压缩、Emotion Images 情绪图片、Regex 输出后处理

### liquidglass-oss — 液态玻璃 UI 组件
- **原作者**: Liquid Glass OSS contributors (Copyright 2026)
- **原始仓库**: https://github.com/ogtirth/LiquidGlass-OSS
- **许可证**: MIT
- **在 Reverie 中的角色**: CSS 玻璃拟态视觉风格参考（backdrop-filter + 半透明面板 + 高光边框）

---

## 非代码参考

### Google Places API (New)
- **用途**: 用户自带 Key 的 Nearby Search (New)，Google 返回结果仅作当前界面临时展示
- **条款**: https://cloud.google.com/maps-platform/terms
- **隐私政策**: https://policies.google.com/privacy
- **说明**: Google Places 数据与服务受 Google Maps Platform 条款、适用政策和署名要求约束

### Live2D Cubism 运行时与用户自带模型
- **Cubism Core**: 公开安装器只分发 `Live2DCubismCore.js`（Live2D Inc. 专有许可，见 `LICENSES_CREDITS/LIVE2D_PUBLICATION_LICENSE.json`）
- **角色模型**: 安装器**不**附带 yumi 或任何 `.moc3` / 纹理 / 动作 / 表情。用户在新手引导中导入自己的 `*.model3.json` 文件夹
- **跟卡**: Live2D 全应用共用一套；角色卡只改人设，不更换模型
- **开发夹具**: 仅开发模式可通过 `REVERIE_YUMI_SOURCE` 指向本机皮套；该路径不得进入公开包

### deepseek_v4_rolepaly_instruct — 角色扮演思考模式指南
- **原作者**: victorchen96 及贡献者
- **原始仓库**: https://github.com/victorchen96/deepseek_v4_rolepaly_instruct
- **性质**: 技术文档/Prompt Engineering 指南，非可执行软件
- **在 Reverie 中的角色**: 角色沉浸/纯分析模式 Prompt 参考

---

## 免 key 联网搜索依赖（2026-09-06 新增，宽松许可直用组件）

经《待实施计划/联网搜索新灵感/》洁室借鉴计划引入。全部为宽松许可证（无 copyleft），
哈希锁定见 `requirements-runtime.lock`。

### ddgs — 免 key 元搜索库（MIT）
- **原作者**: deedy5 及贡献者
- **原始仓库**: https://github.com/deedy5/ddgs
- **许可证**: MIT（全文见 `LICENSES_CREDITS/LICENSE-MIT-ddgs.txt`）
- **在 Reverie 中的角色**: 可选依赖；为网络冲浪提供免 API key 的 SERP 搜索后端。自 2026-09-08 起后端由单一引擎升级为**有序降级链**（bing → duckduckgo → mojeek）：任一后端被封锁/超时/空结果即自动切下一个，抗单一提供方封锁（背景：2026 年 DuckDuckGo 抓取已 CAPTCHA 化、Bing Search API 已退役）。注意其内部 HTTP 出站身份（TLS 指纹与 UA）由该库自行管理（经用户拍板采用此 TLS 路线）。

### primp — ddgs 的 Rust HTTP 客户端（MIT）
- **原始仓库**: https://github.com/deedy5/primp
- **许可证**: MIT（全文见 `LICENSES_CREDITS/LICENSE-MIT-primp.txt`）
- **在 Reverie 中的角色**: ddgs 的**传递依赖**，非 Reverie 直接调用。诚实披露：primp 是一个**浏览器 TLS/JA3 指纹伪装** HTTP 客户端，其存在目的即为绕过 bot 检测；上游自带「仅供教育用途，风险自担」免责声明，使用时可能触及目标站点的 ToS 灰区。Reverie 自有的 httpx 请求（公开 API 引擎、正文抓取）一律使用诚实 UA `Reverie-local/1.x`，**不主动调用 primp 的伪装能力**；此依赖仅随 ddgs 的 SERP 后端间接生效。个人低频使用（个位数查询/天），经用户 2026-09-08 拍板接受此 TLS 路线。

### trafilatura / courlan / htmldate — 正文抽取链（Apache-2.0）
- **原始仓库**: https://github.com/adbar/trafilatura
- **许可证**: Apache-2.0（全文见 `LICENSES_CREDITS/LICENSE-Apache2.0-trafilatura-courlan-htmldate.txt`）
- **在 Reverie 中的角色**: 网页正文抽取（HTML→纯文本），为逐字摘录证据提供素材；缺失时自动降级为内置标签剥离。

### click / lxml / lxml-html-clean / charset-normalizer / justext / babel / dateparser 等 — 传递依赖（BSD/MIT/Apache/双许可）
- **在 Reverie 中的角色**: 上两组组件的传递依赖，全部宽松许可。

---

## ⚠️ AGPL 代码排除声明

经全局代码搜索，以下组件包含 AGPL-3.0 代码，**已明确排除，不会并入 Reverie 代码库**：

1. **NachoBot/koishi-app** (`package.json` 标记为 AGPL-3.0)
2. **NachoBot/NachoBot/plugins/group_muter_plugin** (基于 AGPL-3.0 插件二次开发)
3. **NachoBot/NachoBot/plugins/MaiBot_MCPBridgePlugin** (AGPL-3.0)
4. **NachoBot/NachoBot/src/A_memorix** (默认 AGPL-3.0，有 MaiBot GPL 额外授权)
5. **airi/packages/ccc/test/fixture/seraphina.ts** (引用 SillyTavern AGPL-3.0 资源，测试文件不并入)
6. **KnockOutEZ/wigolo** (AGPL-3.0-only；2026-09-06 起仅作联网搜索架构的**灵感参考**——按洁室协议只借鉴思想/常量/概念，代码、注释、提示词、文件组织零并入，详见 `待实施计划/联网搜索新灵感/`)

> 排除原因：AGPL-3.0 要求网络交互也需开源服务端代码（§13 Remote Network Interaction），与 Reverie 的「客户端 GPLv3 开源 + 云服务闭源商业」架构冲突。

---

## 🧠 记忆架构设计致谢（仅思想参考，未使用代码）

以下项目的设计思想启发了 Reverie 记忆子系统 2026-09-09 批次的架构改进（P0 治理三件套、实体共现图、证据链、typed atoms、折叠 worker、时序检索增强）。**所有新代码均以 Reverie 风格原创编写（clean-room），未移植任何源代码或提示词原文。**

### ALTM — Autonomous Long-Term Memory System（Apache-2.0）
- **原始仓库**: https://github.com/cuiyuestar/Autonomous-Long-Term-Memory-System
- **许可证**: Apache-2.0（与 GPLv3 单向兼容，FSF 官方确认）
- **借鉴内容**: 驻留分/查询分分离原则、预算压力动态门槛、引用反馈闭环设计、证据链五关系模型、typed atoms 结构化记忆概念、持久折叠 worker + checkpoint 续跑模式、fail-closed 治理原则
- **未借鉴**: CCR 压缩策略、多租户 scope、MCP 适配器、tiktoken/jieba 依赖

### Mem0（Apache-2.0）
- **原始仓库**: https://github.com/mem0ai/mem0
- **借鉴内容**: 实体共现图（无需外部图数据库的轻量实体关联）、ADD-only 抽取 + 检索时解冲突的设计理念、多信号检索融合（semantic + keyword + entity boost）

### Letta / MemGPT（Apache-2.0）
- **原始仓库**: https://github.com/letta-ai/letta
- **借鉴内容**: 分层记忆架构模式（core/archival/recall）、sleep-time compute 离线折叠概念

### 学术参考
- **HippoRAG** (NeurIPS 2024, arXiv:2405.14831) / **HippoRAG 2** (ICML 2025, arXiv:2502.14802): PPR 联想检索思想
- **A-MEM** (NeurIPS 2025, arXiv:2502.12110): Zettelkasten 结构化笔记 + 自动链接思想
- **Generative Agents** (arXiv:2304.03442): 多信号检索评分公式（recency + importance + relevance）
- **LongMemEval** (ICLR 2025, arXiv:2410.10813): 评测框架五能力指标对齐

---

## 🎭 角色卡与世界书兼容性设计致谢（仅格式/规格参考，未使用代码）

以下公开规格与项目的角色卡/世界书格式为 Reverie 的 SillyTavern 兼容层提供了字段与格式定义依据。**所有实现代码均以 Reverie 风格原创编写（clean-room），未移植任何源代码、注释、提示词模板或正则表达式。**

### Character Card V2 Specification（开放角色卡规格）
- **仓库**: https://github.com/malfoyslastname/character-card-spec-v2
- **许可证**: 无明确许可证（作为开放规格公开）
- **在 Reverie 中的角色**: 角色卡/世界书导入导出的字段名与格式定义（`chara_card_v2`、`data.*`、`character_book.entries` 等）全部来自此规格

### Character Card V3 Specification（V3 草案规格）
- **仓库**: https://github.com/kwaroran/character-card-spec-v3
- **状态**: DRAFT 草案
- **在 Reverie 中的角色**: 前向兼容设计参考（`ccv3` PNG 块识别），V3 的 Decorator 系统与 CharX 容器暂不实现

### PNG Specification（W3C / ISO/IEC 15948）
- **规格**: https://www.w3.org/TR/png/
- **在 Reverie 中的角色**: PNG tEXt 块的读写（`chara`/`ccv3` 关键字、CRC32 校验）基于此公开标准实现

### SillyTavern（Cohee 及贡献者）— AGPL-3.0
- **仓库**: https://github.com/SillyTavern/SillyTavern
- **在 Reverie 中的角色**: 仅作为**角色卡/世界书格式兼容性**的灵感参考。按洁室协议只借鉴公开规格中的格式与功能概念，代码、注释、提示词、文件组织零并入。许可证分析详见本文档「AGPL 代码排除声明」一节。

---

*文件生成时间：2026-06-26 | Muhe Studio*
