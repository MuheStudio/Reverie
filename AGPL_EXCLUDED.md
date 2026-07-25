# ⚠️ AGPL 排除清单

以下文件和目录包含 AGPL-3.0 许可证代码，**严禁并入 Reverie 代码库**：

## NachoBot 内部 AGPL 组件

- `Cloning-project/NachoBot/koishi-app/` — package.json 标记 AGPL-3.0
- `Cloning-project/NachoBot/NachoBot/plugins/group_muter_plugin/` — AGPL-3.0
- `Cloning-project/NachoBot/NachoBot/plugins/MaiBot_MCPBridgePlugin/` — AGPL-3.0  
- `Cloning-project/NachoBot/NachoBot/src/A_memorix/` — 默认 AGPL-3.0

## AIRI 内部 AGPL 引用

- `Cloning-project/airi/packages/ccc/test/fixture/seraphina.ts` — 引用 SillyTavern AGPL-3.0 资源（测试用）

## 排除原因

AGPL-3.0 §13 要求通过网络交互提供服务时也必须开源服务端源码。Reverie 采取「客户端 GPLv3 + 云服务闭源商业」架构，引入任何 AGPL 代码将迫使云服务端开源，与商业模式冲突。

## 处理方式

- 上述文件/目录在搬运 NachoBot 源码时**必须跳过**
- 搬运前对每个待复制文件进行许可证头扫描
- 如需要使用类似功能，必须从 GPLv3/MIT/Apache2.0 来源重新实现
