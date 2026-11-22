# LICENSES_CREDITS — 第三方许可与来源登记

本目录保留许可证原文、适用通知、资产授权材料及来源登记，随现有打包流程带入产物。**某份许可证文本在目录中存在，不等于该项目源码仍在当前应用中。** 历史移除记录与当前组件分开标记；完整依赖还应核对每次构建生成的许可证清单和 SBOM。

项目根 [`LICENSE`](../LICENSE) 自 2026-11-18 起为 Apache-2.0。本目录保留的 GPL 许可证原文供追溯历史来源。各第三方组件和资产沿用各自条款。迁移过程见 [`docs/LICENSE-MIGRATION.md`](../docs/LICENSE-MIGRATION.md)。

## 登记规则

- 实际复制、移植或 vendored 源码：记录具体来源／版本／路径／修改，保留版权、完整许可及适用 NOTICE。不能用“参考”标签代替来源调查。
- 仅公开规格、论文或设计参考：与实质复用分开登记；不把未经证实的独立实现声明写成审计结论。
- npm、Python 及原生依赖：继续保留各自许可和构建收集结果；锁定版本和包元数据不替代应随产物提供的通知。
- 资产、专有运行时、模型及声音：逐项登记；宿主改许可不会自动改变其条款。
- 原创与其他贡献：按权利人及授权覆盖登记。历史 GPL 声明不要求将有权重新许可的原创代码重写；第三方 GPL 源码仍需单独处理。

## 当前分类（2026-10-05）

机器可读细项见 [`source-provenance.json`](source-provenance.json)，状态由来源、删除提交及实际验收证据决定。

| 项目／许可文件 | 当前证据与处理 |
| --- | --- |
| Kazumi / `LICENSE-GPLv3-Kazumi.txt` | 未集成的 vendored 工程列入首批清理；已在 `e84c994` 移除源码，历史元数据见 `history/kazumi-files.json`；新包验收单独登记 |
| cat-catch / `LICENSE-GPLv3-cat-catch.txt` | 旧 Electron 下载适配器列入首批限定替换；历史元数据见 `history/cat-catch-files.json`；替换验收单独登记 |
| Risuai / `LICENSE-GPLv3-Risuai.txt` | 旧世界书与 Hypa 源码已替换；历史元数据见 `history/risu-worldbook-files.json`、`history/risu-hypa-files.json`，历史通知保留 |
| elephantops 0.1.1 / 构建收集的 npm LICENSE | 实际象棋规则依赖，GPL-3.0-or-later；后续迁移必需任务，当前 GPL 候选保留通知及 Windows 对应源码 |
| NachoBot / `LICENSE-GPLv3-NachoBot.txt` | 历史致谢保留；本次未定位到当前集成源码，不宣称 QQ 适配已实现 |
| NEKO / `LICENSE-Apache2.0-NEKO.txt` + `NOTICE-NEKO.txt` | 记忆导入及互操作桥声明有移植修改，不能统称仅思想参考；合规保留 |
| AIRI / `LICENSE-MIT-airi.txt` | Live2DAdapter 文件头明确声明改编，保留 MIT 通知 |
| pixi-live2d-display / `LICENSE-MIT-pixi-live2d-display.txt` | vendored 0.4.0，保留 Cubism 4 所需构建／类型及 MIT 许可；不包括 Cubism Core 授权 |
| foxgirls.club / `LICENSE-MIT-foxgirls-club.txt` | `src/image_service/` 声明 vendored + Reverie 包装；图像内容版权另论 |
| Luna-ts / `LICENSE-MIT-Luna-ts.txt` | 历史记录同时出现适配与流程参考；具体文件来源映射待核对，保留通知 |
| OpenRoom、liquidglass / 对应 MIT 文本 | 保留历史来源记录，具体复制范围未由本次审计确立，不虚构源码复用结论 |
| sqlite-vec / `LICENSE-MIT-sqlite-vec.txt` | MIT 或 Apache-2.0；当前发行按 MIT 保留通知 |
| ddgs、primp / 对应 MIT 文本 | 搜索的直接／传递运行依赖，合规保留 |
| trafilatura、courlan、htmldate / 对应 Apache-2.0 文本 | 正文抽取依赖，合规保留；其他传递依赖按各自条款收集 |
| `LIVE2D_PUBLICATION_LICENSE.json` | Cubism Core 专有运行时；维持既有出版门禁，按实际构建检查是否带入 |
| `FOCUS-SOUNDS-NOTICE.txt`、`YUMI-ASSET-NOTICE.txt`、`YUMI_CHARACTER_RIGHTS.json` | 声音／角色资产独立权利记录，不随宿主许可改变 |

保留的宽松许可组件不是迁移前置重写清单。“模块隔离”或默认关闭不应被描述为自动消除 copyleft 的依据。修改 vendored 组件时记录自己的修改及日期，保留原权利人原始版权行，不擅自替换其年份或作者。
