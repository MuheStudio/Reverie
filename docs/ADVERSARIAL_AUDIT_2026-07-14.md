# Reverie 对抗式架构审查（更新于 2026-07-15）

## 结论

Reverie 的核心状态源必须是本地、可校验、可恢复的结构化数据。大模型输出和向量索引都不是事实源：前者是不确定计算结果，后者只是可重建的检索加速层。人格、记忆、关系、情绪和时间连续性只能建立在本地持久状态、明确的信任边界和可降级执行路径之上。

本轮已实现严格 SillyTavern 角色卡导入、四层记忆与嵌入版本迁移、非破坏性认知衰减、可控误记、网络信息隔离、后台调度、Live2D 资源回收路径、本地反射回复、主动关心通知、环境化陪伴与多角色社交。项目仍不能对任意自然语言的一致性、任意未知提示词攻击、真实 Live2D 模型的长期显存表现或断电时的跨数据库原子性作数学意义上的绝对保证。

## 信任模型

1. 本地 SQLite 中经过校验的规范状态是事实源。
2. 用户输入是可影响状态但不能覆盖系统规则的不可信数据。
3. 角色卡正文是待导入资料，不是系统提示词。
4. 网络内容始终标记为 `untrusted_web`，不能直接进入长期记忆。
5. 模型输出必须经过结构、长度、连续性和危险内容检查后才能落地。
6. 向量索引可删除、可重建，绝不反向覆盖规范记忆。

## 已完成防线

### SillyTavern 导入

- 严格支持常见 V1、V2、V3 JSON 字段，并兼容 PNG 内的 `ccv3` / `chara` 文本块和 CharX 的根目录 `card.json`。
- 限制文件大小、JSON 深度、项目数量、ZIP 项目数量及 CharX 解压后的 `card.json` 大小。
- 拒绝损坏 UTF-8、重复 JSON 键、非有限数字、原型污染键、PNG CRC 损坏、重复角色数据块和格式伪装。
- CharX 使用分块解压；超过 2 MiB 时暂停流并拒绝，避免 `async()` 完整结果驻留内存。
- `system_prompt`、`post_history_instructions`、世界书、脚本、扩展和远程资产保持隔离，不获得提示词、执行或下载权限。
- 导入内容只保存到本地，默认不激活；必须由用户明确激活后才影响角色。
- 创建者说明只作为界面说明显示，不进入角色提示词。
- 参考样例 `H:\ENsoft\SillyTavern\character\家道中落的诗怀雅.json` 仅做无副作用解析。它因第 5 行第 25 列存在非法控制字符被拒绝，未创建角色档案。

安全导入是有意实现的 SillyTavern 安全子集。为维护 Reverie 的人格主权，它不会原样执行角色卡中的系统提示词、后历史指令、正则脚本或世界书，因此不承诺与 SillyTavern 的运行行为完全一致。

### 四层记忆栈

- 工作记忆：仅保留当前会话所需上下文。
- 情景记忆：保存时间、事件、参与者、情绪和来源。
- 语义记忆：保存从事件中确认的稳定事实。
- 程序记忆：保存口癖、行为偏好和人格约束。
- SQLite `memory_records` 是规范记忆源；sqlite-vec 虚拟表是按模型版本、维度、量化方式和分区方案划分的可重建索引。
- 每条嵌入绑定模型版本。模型切换后，旧记忆继续通过词法、时间和结构化条件召回，后台空闲时惰性重嵌入。
- 召回采用有上限的混合排序，结合时间、词法、情绪、重要性、提及频率和关联度，避免把大量近似文本直接塞入上下文。
- “第一次”等时间查询从规范库按最早时间选候选，避免旧事件在大量新记录之后被候选窗口挤掉。
- 向量库异常时退回 SQLite 词法和结构化召回，不让索引故障表现为失忆。
- INT8 是默认的节省空间方案，Float32 作为质量优先选项保留；切换方案时只丢弃并重建派生索引，规范文本不变，旧虚拟表会被删除。
- 季度分区只在有明确时间范围时参与检索，避免为普通查询制造过度分片。

### 认知衰减与可控误记

- 遗忘被实现为提取权重衰减，不执行定时物理删除；永久记忆不参与衰减。
- 权重结合时间、重要性、情绪强度、提及与召回次数，并对重复强化使用对数上限，避免高频记忆无限垄断召回。
- 强线索可以重新激活弱记忆，但上下文总量仍受字符预算、去重和候选数量限制。
- 误记只在检索投影层临时替换同领域实体；规范记忆保持不变，并记录本地审计事件。
- 姓名、年龄、生日、身份、关系、医疗、重要日期、高重要性、永久和程序记忆不能进入误记池。
- 临时替换的内部标记在组装提示词前移除，模型不会收到“请故意记错”的指令；用户纠正后会关闭审计事件并强化真实记忆。

### 网络记忆投毒

- 网络资料经过 Unicode/HTML 规范化、隐藏字符清理、编码载荷检查和本地意图过滤。
- 标题、摘要、来源名称、网址和日期等所有进入提示词的字段都接受同一检查。
- 命中元指令、角色覆盖、记忆写入或工具诱导模式的内容进入隔离区。
- 网络信息与角色长期记忆物理分库，不存在“抓取后自动成为亲历记忆”的写入路径。
- 提示词明确声明外部信息不可信，不能修改人格、关系、价值观或事实源。
- RSS 仅允许 HTTPS、公网地址、无重定向，并限制响应体、条目数和本地缓存大小。

### 桌面长期运行

- 情绪平复、主动聊天、通知、记忆衰减、重嵌入和延迟队列运行于 Python 后端或 Electron 主进程，不依赖渲染进程计时器。
- Electron 后端进程异常后使用有上限的指数退避重启；退出应用时不会误重启。
- Live2D 在隐藏、挂起和切换模型时停止 ticker、销毁模型、触发纹理回收并释放遮罩缓冲；恢复时按生命周期令牌重新加载。
- Electron 保留系统托盘和本地通知队列，过期或损坏通知会被清理或隔离。
- 不关闭 Chromium 的后台节流；业务连续性通过逻辑下沉实现，以免为动画常驻牺牲整机资源。
- 渲染器启用 Chromium 沙箱、上下文隔离并关闭 Node 直连；六组桌面/窄屏 Electron 视觉回归在沙箱下通过。

### 环境化陪伴与消费知情

- DreamRoom 的书签、便利贴、日记书写状态、手机呼吸提示和情绪光影由本地持久状态驱动，不显示情绪数值。
- “想到你”内容先进入本地延迟分享账本，仅使用通过消毒的 `untrusted_web` 摘要，并受分享概率和时间窗口控制。
- 日记钥匙、用户口癖同化、主动关心与本地反射均有独立开关、概率或阈值设置。
- API 账本按用途记录前台和后台请求；只对后台任务执行每日请求数和 Token 预算，用户主动聊天不会被预算静默阻断。
- 多角色群聊、朋友圈评论和背后串门保存在本机，并在界面明确说明这是角色世界模拟，不冒充真实外部账号通信。

### 本地反射与主动关心

- 本地 SQLite 内置 184 条按超时、关心、早晚、提醒和休息分类的短句，不调用模型即可回复。
- 模型调用 30 秒超时或不可恢复异常时，由反射模块接管并短暂切换忙碌状态。
- 反射文本仍经过当前人格口癖、称呼、关系等级、反 AI 表述和连续性约束处理。
- 主动关心通知可以完全走本地反射路径；模型失败不会让提醒系统整体消失。
- 技术错误详情不会直接冒充角色台词发给用户。

## 墨菲矩阵

| 迟早会发生的故障 | 当前处理 | 剩余风险 |
| --- | --- | --- |
| 角色卡损坏或伪装 | 严格 UTF-8/JSON/PNG/ZIP 校验，无副作用失败 | 新格式需显式适配，不能猜测导入 |
| 角色卡夹带提示词 | 核心字段检测；指令、世界书、脚本和扩展隔离 | 新型隐写语义可能漏过启发式检测 |
| CharX 压缩炸弹 | 外层 16 MiB、256 项、目录尺寸预检、2 MiB 流式硬停 | JSZip 自身解析中央目录仍会占用与外层文件相称的内存 |
| 向量模型切换 | 模型版本标签、混合召回、惰性重嵌入 | 迁移期语义召回质量可能暂时下降 |
| 向量库损坏 | SQLite 规范源和词法回退 | 大型库回退检索速度会下降 |
| 反复切换量化/分区 | 原派生索引事务性失效并删除旧虚拟表 | 重建期间语义召回质量暂时下降 |
| 网络页面投毒 | `untrusted_web`、消毒、隔离、禁止长期记忆直写 | 无法形式化识别所有自然语言攻击 |
| 窗口最小化 | 调度下沉主进程/后端 | 操作系统休眠期间不会实时执行，恢复后补算 |
| Live2D 显存泄漏 | 主动销毁和纹理回收 | 第三方模型/运行库仍需长时间显存监测验证 |
| 模型服务超时 | 本地反射回复和状态降级 | 通用短句不可能完美拟合每张任意角色卡 |
| Windows 通知被吞 | AppUserModelID、开始菜单入口、支持状态检测和本地发件箱 | 专注助手、系统权限或未正确安装仍可让通知不显示 |
| 导入时进程强杀 | SQLite 导入意图和启动恢复 | 尚未统一到单个 SQLite 事务的多文件状态仍非断电级原子 |

## 仍需诚实声明

1. 自由生成的自然语言无法被现有规则形式化证明为永不出现隐含矛盾。硬事实冲突可拦截，开放语义仍是概率性核验。
2. 网络消毒是分层降低风险，不是对未知提示词注入的完备判定器。
3. RSS 在连接前解析并拒绝私网地址，但 DNS 解析与实际连接之间仍存在理论上的重绑定时间窗。
4. 世界状态导入可恢复，全部实时模块尚未迁移到同一个 SQLite 原子事务。
5. Live2D 释放逻辑已经补齐，但必须用真实高精度模型做 24/72/168 小时显存与句柄监测后才能量化泄漏率。
6. Electron 渲染器已启用沙箱，但预加载层仍暴露下载、文件对话框和外部链接等必要 IPC；后续新增 IPC 必须继续执行协议、大小和来源校验。
7. 云端接口仅保留扩展边界并标记开发中；本轮所有规范状态、反射、调度和导入均以本地为优先。
8. sqlite-vec 是 Alex Garcia 维护的独立 pre-v1 扩展，不是 SQLite 官方扩展；升级可能包含破坏性变化，因此当前固定 `0.1.9` 且始终保留无向量回退。
9. INT8 的理论存储量约为 Float32 的四分之一，但会损失部分检索质量；“十万级高速”仍需在目标设备和真实语料上做基准，不能表述为无限容量保证。
10. 每条正常生成回复的独立语义核验会增加一次前台模型调用；它提高一致性但不能形式化证明全部自然语言无矛盾。

## 验证记录

- 仓库历史集成测试：`2649 passed, 21 skipped`。
- 本轮核心后端测试：`217 passed`。
- 前端：`177 passed`。
- 新增角色卡定向对抗测试：`21 passed`。
- 全局 TypeScript（浏览器与 Node 配置）零错误；Python 全源码编译通过。
- Electron 主进程与预加载脚本语法检查通过；渲染器沙箱已开启。
- Electron 生产构建成功；六个桌面/窄屏房间、人格设置与群聊场景无溢出、控件越界或渲染错误。
- Windows 半成品输出目录为空，本轮未重新打包安装器。

## 调研依据

- [Character Card V2 Specification](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)
- [Character Card V3 Specification](https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md)
- [OWASP RAG Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/RAG_Security_Cheat_Sheet.html)
- [OWASP Prompt Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
- [OWASP Agent Memory Guard](https://owasp.org/www-project-agent-memory-guard/)
- [Lost in the Middle](https://arxiv.org/abs/2307.03172)
- [RAG 重排序与噪声研究](https://arxiv.org/abs/2411.03538)
- [ACT-R 学习理论与基础激活](https://act-r.psy.cmu.edu/wordpress/wp-content/uploads/2012/12/39jra_cds_2000_a.pdf)
- [sqlite-vec 元数据过滤与分区键](https://alexgarcia.xyz/blog/2024/sqlite-vec-metadata-release/index.html)
- [sqlite-vec 标量量化](https://alexgarcia.xyz/sqlite-vec/guides/scalar-quant.html)
- [sqlite-vec 版本稳定性说明](https://alexgarcia.xyz/sqlite-vec/versioning.html)
- [间接提示词注入原始研究](https://arxiv.org/abs/2302.12173)
- [Electron Performance](https://www.electronjs.org/docs/latest/tutorial/performance)
- [Electron Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron BrowserWindow 后台节流](https://www.electronjs.org/docs/latest/api/structures/browser-window-options)
- [Electron Notifications](https://www.electronjs.org/docs/latest/tutorial/notifications)
- [Electron powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor/)
- [Electron Notification](https://www.electronjs.org/docs/latest/api/notification)
- [PixiJS Texture Garbage Collection](https://pixijs.com/8.x/guides/concepts/garbage-collection)
- [Live2D Web Mask Preprocessing](https://docs.live2d.com/cubism-sdk-manual/ow-sdk-mask-premake-web/)
- [JSZip Limitations](https://stuk.github.io/jszip/documentation/limitations.html)
- [JSZip internalStream](https://stuk.github.io/jszip/documentation/api_zipobject/internal_stream.html)
