# LICENSES_CREDITS — 第三方许可与来源登记索引

本目录是 Reverie 的第三方许可与来源登记处（单一事实源）。打包流程会把本目录整体带入发行物。

## 分类政策

| 类别 | 是否需登记 | 说明 |
| --- | --- | --- |
| **思想 / 架构借鉴** | 否（可选致谢） | 学结构、学思路、学公式，不复制代码。鼓励在文件头写一行 `inspired by <source>` 便于 review |
| **实质性代码复用**（≥一行实质逻辑） | **必须** | 在本目录新增 `<LICENSE>-<project>.txt` 全文，并在被移植文件头部注明来源文件与许可 |
| **npm 依赖** | 否 | 以 `package.json` + 各自仓库许可为准；引入新重依赖时在本 README 追加一行 |
| **专有运行时 / 资产 / 权重** | **必须** | Live2D Cubism Core、模型权重、语音权重等不随宿主 MIT/私有许可变化，逐项登记 |

## 现有登记（盘点于 2026-09-05）

| 文件 | 覆盖对象 | 类别 |
| --- | --- | --- |
| `LICENSE` | Reverie 自身 | — |
| `LICENSE-MIT-Luna-ts.txt` | 来自 Luna-ts（github.com/Alan-Yu-2077/Luna-ts，© Alan-Yu-2077）的代码与流程。当前关联：`frontend/electron/optional-runtime-provisioner.cjs`（供应流程 inspired by 其 ttsProvision）、`frontend/src/utils/reconnectTiming.ts`（等量抖动重连惯例） | 思想+轻量借鉴 |
| `LICENSE-MIT-pixi-live2d-display.txt` | vendored `frontend/vendor/pixi-live2d-display`（© 2020 Guan, MIT） | 代码复用 |
| `LICENSE-MIT-sqlite-vec.txt` | sqlite-vec 相关 | 依赖 |
| `LICENSE-MIT-OpenRoom.txt` / `-airi.txt` / `-foxgirls-club.txt` / `-liquidglass-oss.txt` | 对应前端模块来源 | 代码复用 |
| `LICENSE-Apache2.0-NEKO.txt` + `NOTICE-NEKO.txt` | NEKO（Apache-2.0 附 NOTICE 义务） | 代码复用 |
| `LICENSE-GPLv3-Kazumi.txt` / `-NachoBot.txt` / `-Risuai.txt` / `-cat-catch.txt` | GPL-3.0 来源模块（隔离使用，见各自 NOTICE） | 代码复用 |
| `LIVE2D_PUBLICATION_LICENSE.json` | Live2D Cubism Core 运行时（Live2D Inc. 专有许可，**非 MIT**；发行受其收入条款约束） | 专有运行时 |
| `FOCUS-SOUNDS-NOTICE.txt` | 专注音效资产 | 资产 |
| `YUMI-ASSET-NOTICE.txt` / `YUMI_CHARACTER_RIGHTS.json` | 角色形象与皮套资产权利（自持，非自由许可） | 资产 |

## 通用注意

- **BYO 模型 / 语音权重**（GPT-SoVITS 音色包、Live2D 模型文件等）由用户自带，许可归各自权利人，不因运行在 Reverie 中而改变。公开安装器只带 Cubism Core，不带任何角色模型。
- GPL 来源代码保持模块隔离，不得与专有许可代码链接合并；新增 GPL 依赖前先确认隔离边界仍然成立。
- 修改任何 vendored 依赖时，同步更新对应 LICENSE 文件内的版权年份与版本说明。
