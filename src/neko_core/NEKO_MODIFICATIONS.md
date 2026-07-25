# N.E.K.O 代码修改声明 (Apache 2.0 Modification Notices)

> 本文件根据 Apache License 2.0 §4 创建。
> 记录所有从 Project N.E.K.O. 搬运并修改的源代码文件的变更说明。

## 原始版权

Copyright 2025-2026 Project N.E.K.O. Team
Licensed under the Apache License, Version 2.0

## 全局修改声明

以下声明适用于 `src/neko_core/` 目录下的所有 `.py` 文件：

```
-- 修改说明 --
Modified by Muhe Studio in 2026.
Changes made:
  1. 集成至 Reverie 统一架构（桌面 AI 伴侣系统）
  2. 调整模块导入路径以适配 Reverie 项目结构
  3. 本地化运行模式：移除云端依赖，改为本地进程通信
  4. 通信接口由 HTTP → 本地 WebSocket/进程间通信
  5. 前端隔离：原 Web UI 替换为 OpenRoom 桌面环境
  6. 配置系统适配：统一到 Reverie config/settings 模块
  7. 遥测系统添加 DO_NOT_TRACK 默认开启本地模式
```

## 具体文件修改

### launcher.py
- 原路径: N.E.K.O/launcher.py
- 新路径: src/neko_core/launcher.py
- 修改: 入口点整合到 Reverie 主程序，不再作为独立启动器

### main_logic/core.py
- 原路径: N.E.K.O/main_logic/core.py
- 新路径: src/neko_core/main_logic/core.py
- 修改: 对话管道适配 Reverie 的 ChatSession 接口

### memory/facts.py, memory/reflection.py, memory/persona.py
- 原路径: N.E.K.O/memory/*.py
- 新路径: src/neko_core/memory/*.py
- 修改: 与 Reverie 现有的 LanceDB 向量记忆系统互操作

### brain/computer_use.py, brain/browser_use_adapter.py
- 原路径: N.E.K.O/brain/*.py
- 新路径: src/neko_core/brain/*.py
- 修改: Agent 工具执行适配 Windows 本地环境

---

*声明文件创建时间：2026-06-26 | Muhe Studio*
*本文件随源代码一同分发，满足 Apache 2.0 修改声明义务*
