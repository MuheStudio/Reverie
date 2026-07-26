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
- **在 Reverie 中的角色**: 参考并适配头部中心、按距离缩放的鼠标视线跟随算法
- **边界**: Reverie 开发模式只从原仓库位置读取 Cubism Core，不复制或重新授权该专有文件

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

### Yumi 公共皮套预览
- **来源**: 项目所有者于 2026-07-25 提供的本地 `皮套-yumi` 文件夹
- **当前使用范围**: 普通构建仅包含 `yumi.png` 静态主界面预览
- **发布边界**: `.moc3`、纹理、动作、表情与 Cubism 运行库不进入未获许可的发行包
- **待补信息**: 正式公开分发前需补记原作者、来源链接与资源再分发条款
- **详细记录**: `LICENSES_CREDITS/YUMI-ASSET-NOTICE.txt`

### deepseek_v4_rolepaly_instruct — 角色扮演思考模式指南
- **原作者**: victorchen96 及贡献者
- **原始仓库**: https://github.com/victorchen96/deepseek_v4_rolepaly_instruct
- **性质**: 技术文档/Prompt Engineering 指南，非可执行软件
- **在 Reverie 中的角色**: 角色沉浸/纯分析模式 Prompt 参考

---

## ⚠️ AGPL 代码排除声明

经全局代码搜索，以下组件包含 AGPL-3.0 代码，**已明确排除，不会并入 Reverie 代码库**：

1. **NachoBot/koishi-app** (`package.json` 标记为 AGPL-3.0)
2. **NachoBot/NachoBot/plugins/group_muter_plugin** (基于 AGPL-3.0 插件二次开发)
3. **NachoBot/NachoBot/plugins/MaiBot_MCPBridgePlugin** (AGPL-3.0)
4. **NachoBot/NachoBot/src/A_memorix** (默认 AGPL-3.0，有 MaiBot GPL 额外授权)
5. **airi/packages/ccc/test/fixture/seraphina.ts** (引用 SillyTavern AGPL-3.0 资源，测试文件不并入)

> 排除原因：AGPL-3.0 要求网络交互也需开源服务端代码（§13 Remote Network Interaction），与 Reverie 的「客户端 GPLv3 开源 + 云服务闭源商业」架构冲突。

---

*文件生成时间：2026-06-26 | Muhe Studio*
