# Reverie（幻梦）

> **任何人都可以拥有自己的数字人格伴侣，但没有人能把社区贡献据为己有然后关门收费。**
>
> — Muhe Studio（沐禾工作室）

## What is Reverie?

Reverie 是一个本地优先的 AI 数字伴侣系统。她不是一个简单的聊天机器人——她有记忆、有情绪、有关系、有癖好、有自己的"生活"。

- 🧠 **记住你**：跨会话长期记忆（五维记忆系统：工作/近期/事实/反思/人格）
- 💓 **真实情绪流动**：八字基础情绪模型，情绪有惯性、不突兀
- 🗣️ **像人一样说话**：可变长度回复、打字延迟、分条发送
- 🌱 **与你一起成长**：关系演化、兴趣改变
- 🏠 **有自己的生活**：日记、动态、朋友圈、随机事件
- 💻 **本地运行**：所有数据在自己设备上，无需云端
- 🎭 **可见可触**：Live2D/VRM 虚拟形象，实时语音对话

## 开源协议

**本项目单机客户端整体以 GNU GPLv3 协议开源。**

## 借鉴与致敬

Reverie 是在以下优秀开源项目的基础上融合开发的衍生作品。我们深度致敬：

| 项目 | 许可证 | 借鉴内容 |
|---|---|---|
| OpenRoom (VibeApps) | MIT | 桌面环境骨架、日记应用、AI Agent 应用操作 |
| Project AIRI | MIT | VRM/Live2D 虚拟形象、语音管道、LLM 提供商适配 |
| N.E.K.O | Apache 2.0 | 五维记忆系统、主动陪伴、实时语音对话 |
| cat-catch（猫抓） | GPL-3.0 | 网络资源嗅探与下载 |
| foxgirls.club | MIT | 随机图片服务 |
| Kazumi | GPL-3.0 | XPath 规则引擎、Anime4K 超分辨率 |
| NachoBot | GPLv3 | QQ 多平台适配（后期集成） |
| Risuai | GPL-3.0 | Tauri 桌面壳、Lorebook 世界书、HypaMemory 记忆压缩、Emotion Images 情绪图片 |

所有原始许可证、版权声明均保留在 `LICENSES_CREDITS/` 目录中。详见 `CREDITS.md`。

## 🌐 云服务声明

本软件中预留的云端接口（数据备份、AI 算力托管、联机加速）指向的云端后台属于**独立的商业专有服务**，不在 GPLv3 开源范围内。云端系统源码、计费系统及 AI 算力模型属于完全闭源的商业财产。

## 快速开始（Windows）

### 前置条件

- Python 3.11+（N.E.K.O 模块要求 3.11）
- Node.js 18+
- Git

### 开发运行

```powershell
# 克隆项目
git clone https://github.com/Muhe-Studio/Reverie.git
cd Reverie-project/Reverie-Windows

# Python 后端
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt

# 前端（待集成 OpenRoom）
cd frontend
pnpm install
pnpm dev
```

## 项目结构

```
Reverie-Windows/
├── LICENSE                # GPLv3 主协议
├── NOTICE                 # Apache 2.0 必要通知（合并自 N.E.K.O）
├── CREDITS.md             # 完整版权归属
├── AGPL_EXCLUDED.md       # AGPL 排除清单
├── LICENSES_CREDITS/      # 所有借鉴项目的原始许可证
│   ├── LICENSE-GPLv3-cat-catch.txt
│   ├── LICENSE-GPLv3-Kazumi.txt
│   ├── LICENSE-GPLv3-NachoBot.txt
│   ├── LICENSE-Apache2.0-NEKO.txt
│   ├── NOTICE-NEKO.txt
│   ├── LICENSE-MIT-airi.txt
│   ├── LICENSE-MIT-foxgirls-club.txt
│   └── LICENSE-MIT-OpenRoom.txt
├── src/                   # Python 后端（N.E.K.O 核心 + foxgirls.club）
├── frontend/              # TypeScript/React 前端（OpenRoom 骨架 + AIRI 渲染）
├── data/                  # 本地数据存储
├── tests/                 # 测试
└── README.md
```

## 技术架构

```
┌─────────────────────────────────────────────────────────┐
│                    Reverie 主程序                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │          OpenRoom (TypeScript/React/Vite)          │  │
│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌────────┐ ┌──────┐  │  │
│  │  │ 日记  │ │ 音乐  │ │ 游戏  │ │ 图片   │ │ 番剧  │  │  │
│  │  └──────┘ └──────┘ └──────┘ └────────┘ └──────┘  │  │
│  │         ┌──────────────────────┐                  │  │
│  │         │  AIRI VRM/Live2D 层  │                  │  │
│  │         └──────────────────────┘                  │  │
│  └──────────────────┬────────────────────────────────┘  │
│                     │ WebSocket                         │
│  ┌──────────────────┴────────────────────────────────┐  │
│  │          Python 本地服务层                          │  │
│  │  ┌──────────────┐  ┌──────────────────┐           │  │
│  │  │  N.E.K.O      │  │  foxgirls.club    │           │  │
│  │  │  ·记忆系统    │  │  ·随机图片API     │           │  │
│  │  │  ·主动陪伴    │  │  ·图片代理       │           │  │
│  │  │  ·语音对话    │  └──────────────────┘           │  │
│  │  │  ·Agent工具   │                                │  │
│  │  └──────────────┘  ┌──────────────────┐           │  │
│  │                     │  cat-catch        │           │  │
│  │                     │  ·资源嗅探下载    │           │  │
│  │                     └──────────────────┘           │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## 参与贡献

欢迎 Fork、PR、修改。所有衍生作品必须保持 GPLv3 开源。

---

*© 2026 Muhe Studio（沐禾工作室）*
