# Windows 移植指南 · 七期原生预览

这份指南给把 Reverie 原生预览移植到 Windows 的开发者。当前宿主使用 Qt Quick，后端使用 Python，两者通过专用进程通道通信。七期源码快照为 `2640b89a`，Mac 版本通过 7,846 项测试、七组业务界面检查和版本升级检查。Windows 的构建、安装、性能与系统交互仍待实机验证。

在已有的 `newui` 上拉取更新即可保留之前的公开历史。七期项目代码采用 Apache-2.0，第三方代码和素材适用各自的许可证。此前按 GPLv3 发布的快照仍可按当时的许可使用。向此版本贡献改动时，请确认贡献可以按 Apache-2.0 提供。许可证及组件归属见[根许可证](../LICENSE)、[通知](../NOTICE)和[来源说明](../CREDITS.md)。

## 1. 范围和构建入口

与上次交付相比，七期增加了形象管理、世界书文件导入导出、四种棋、日记、主动消息、聊天图片、收藏、房间画质与颜文字。关系、情绪等状态按人格保存。旧 Electron 源码仍可供参考，其聊天视频下载已退役。Windows 需要移植的是 Qt 宿主及其启动、存储和验证链。

|组成|当前实现及移植工作|
|---|---|
|Qt 和 C++|CMake 最低 3.24，C++20，Qt 6.11.2。需要 Quick、QuickControls2、Network、OpenGL、Test、ShaderTools 和 GuiPrivate。工程当前指定 OBJCXX、arm64、macOS 14，并编译若干 Objective-C++ 文件。应按平台选择源文件、编译参数、框架及工具路径。|
|Python|项目使用 Python 3.12，Mac 验证解释器为 3.12.14。按运行锁验证原生依赖，尤其是 SQLCipher 与 sqlite-vec。SQLCipher 无法使用时应拒绝打开受保护的库。|
|Node 与规则|配置阶段需要 Node 和前端锁定的 TypeScript。Node 还参与候选和安装文件的完整性验证。|
|角色渲染|可构建不含 Core 的版本。启用角色渲染时，现有 CMake 需要本地获授权的 Cubism Native SDK，并静态链接对应平台的 Core；Windows 需自行准备 SDK、相应库和模型。公开分支提供调用端代码。|

构建目标和依赖版本见 [CMake](../native-ui/CMakeLists.txt)、[Qt 工具链](../config/qt-macos-toolchain.json)、[Python 依赖锁](../requirements-runtime.lock)及[前端依赖](../frontend/package.json)。

## 2. 凭据与父子进程传钥

`Keychain.h` 已提供存储钥和服务凭据接口。Windows 可以实现同一组声明。存储钥恰好 32 字节，账户绑定传入数据根路径字符串的 UTF-8 SHA-256。Local 和 Preview 各有独立的存储钥与服务凭据命名空间。根目录已有文件名含 `.sqlite` 或 `.db` 的数据库而钥缺失时，应报告错误、保留原库。provider 记录保留 `schema/binding/apiKey/writeId`；目的地由用途、provider 和 base URL 共同绑定。写入后可读回，重复清除应安全。测试清理只接受经过验证的临时目标。[接口](../native-ui/src/Keychain.h) · [Mac 实现](../native-ui/src/Keychain.mm)

现有 Mac 宿主通过匿名管道传递存储钥。子进程启动时把读端映射到 fd 3，父进程写入原始 32 字节后关闭写端并清零缓冲。Python 在打开数据库前取走通道定位信息，读到 EOF 或第 33 字节，只接受恰好 32 字节，随后关闭读端并清零临时缓冲。桥接鉴权与存储钥各有专用用途。启动、升级检查和性能造数分别有一处宿主调用。[宿主接口](../native-ui/src/StorageKeyChannel.h) · [POSIX 实现](../native-ui/src/StorageKeyChannelPosix.cpp) · [Python 读端](../src/storage/encrypted_sqlite.py)

Windows 需要约定可继承 HANDLE 和 Python 二进制读端的映射、所有权、EOF 和启动期限。只将所需读端交给目标子进程，保持钥本身仅在系统凭据存储、内存及专用通道中出现。已有 9 个后端引导测试和性能造数程序检查 fd 3、FIFO 等 POSIX 性质。移植时应同时提供等效夹具，并用真实父子进程检查短读、长读、端点关闭以及相关进程的回收。[平台契约测试](../native-ui/tests/PlatformContractTest.cpp) · [性能造数入口](../native-ui/perf-fixtures.py)

## 3. 工作区、按人格保存与恢复

Windows 需要私有的每用户数据目录、稳定的文件身份、单实例内核锁、链接及特殊文件检查、持久化写入、原子改名和恢复状态检查。安装目录与用户数据分别管理。遇到高于宿主支持版本的数据格式，应在启动后端之前拒绝。升级和恢复须保留快照、文件校验及恢复后的候选编号。[工作区](../native-ui/src/PreviewWorkspace.cpp) · [平台文件操作](../native-ui/src/PreviewPlatform.cpp) · [快照](../native-ui/src/PreviewSnapshot.cpp) · [恢复](../native-ui/src/PreviewRestore.cpp)

- 主动消息触发状态、沉默处理标记、图片和收藏使用现有加密存储。旧的待处理记录先导入并提交事务，复核原文件身份后才清理。移植时要覆盖文件被占用或替换、提交后中断和重启。关系、情绪、日记与收藏应按当前人格读取。[待处理记录](../src/chat/encrypted_pending.py) · [存储层](../src/kernel/storage.py)
- 原生预览把主动消息广播给应用内会话，关闭两种系统通知标记。界面按人格、消息 ID、代次和时间校验事件，再读取历史。Windows 端无需为此功能启用系统通知服务。日记按本地日期工作，收藏回忆也依赖本地日界，需验证跨日、时区和重启。[事件发布](../src/bridge/ws_bridge.py) · [收藏](../src/keepsakes/preview.py)
- 便携备份涵盖其定义的业务数据。完整工作区快照包含加密库。恢复便携备份时不能假定聊天附件随之恢复。[备份范围](../src/backup.py)
- 仍须保留父子鉴权、私有控制帧、请求关联、取消和迟到结果检查。档案修订冲突要保留草稿；写入结果未知时先读回。诊断只记录获准的计数、长度和原因。[桥接](../src/bridge/stdio_bridge.py) · [档案存储](../src/archive/store.py)

## 4. 图片、剪贴板与文件对话框

**选图预览是一个新增的编译障碍。** 主程序、RuntimeBridgeTest 和 PersonaCardConfirmationTest 都编入 `RuntimeBridgeImage.cpp`，无条件包含和链接 Apple ImageIO、CoreFoundation。Windows 需要在这三个目标替换这部分解码与缩略图实现。可核对 JPEG、PNG、GIF、WebP 的内容识别，首帧、图像方向、24 百万像素及 5 MiB 文件上限和最长边 320 像素的预览。若选择 Qt 图像插件，部署时也要验证 WebP 等解码器在目标机确实可用。[图片实现](../native-ui/src/RuntimeBridgeImage.cpp) · [构建目标](../native-ui/CMakeLists.txt)

**Python 文件读端的一行改法。** `src/chat/media.py` 第 188 行的 `_open_image_file` 直接访问 `os.O_NONBLOCK`。Windows 缺少此常量，选文件发送图片时会抛出 `AttributeError`。移植版本可将该行改为下式，使支持该标志的平台继续采用非阻塞打开。打开后的普通文件检查、大小限制和解码校验仍需执行。[文件读端](../src/chat/media.py#L187)

```python
return os.open(path, flags | getattr(os, "O_NONBLOCK", 0))
```

剪贴板走 Qt 的系统粘贴快捷键和 `QClipboard` 图像数据。选文件时传本地绝对路径，粘贴时先按比例缩至最长边 1280，再产生上限 350,000 字符的 JPEG data URL。缩略图按媒体 ID 从加密库回读。需在 Windows 验证系统选图器、剪贴板图像、输入法组合文本、取消和超限拒绝；现有界面测试可以替代选图器。[聊天窗口](../native-ui/qml/ChatPanel.qml) · [图片测试](../tests/test_preview_chat_image.py)

世界书打开和保存使用 Qt 文件对话框，建议文件名放在系统文档目录。导入要求本地普通 JSON 文件，导出经同目录临时文件、刷新、原子替换完成。需核对盘符、UNC、重解析点、文件占用和操作期间的人格切换。形象导入使用目录选择器，删除先在同目录改名，再清理；验证中断后重读和重启清理。[世界书文件操作](../src/worldbook/file_format.py) · [世界书界面](../native-ui/qml/ArchiveDrawer.qml) · [形象文件管理](../frontend/electron/avatar-manager.cjs)

## 5. 四种棋、显示缩放与图形

构建时 `compile-rules.cjs` 从 TypeScript 生成四份 JavaScript，CMake 把它们作为 Qt 资源打包。象棋、五子棋、国际象棋和围棋分别读取 `rules.js`、`gomoku-rules.js`、`chess-rules.js`、`go-rules.js`。运行时由 QJSEngine 执行；测试目标同样需要这些资源。Windows 上应验证生成器路径、资源名、合法走法及旧棋局回放。[规则生成器](../native-ui/compile-rules.cjs) · [宿主加载](../native-ui/src/RuntimeBridge.cpp)

房间画质只调节背景环境着色器。清晰档始终使用设备像素比，流畅档使用半比例且最低为 1，默认均衡档在画面变化时降到该比例，静止 250 ms 后还原。图层采用平滑采样。画质与离线、减少动态效果、降低透明度一起写入 `qt-appearance.json`。验证非整数显示缩放、不同 DPI 显示器间移动、三档切换和重启读回。[背景图层](../native-ui/qml/SceneBackdrop.qml) · [设置界面](../native-ui/qml/TaskPanel.qml)

当前宿主和离屏预览使用 OpenGL 渲染链。保留该路径时应验证驱动和 Cubism 渲染器；选择其他图形后端时，还要验证 shader、离屏纹理及角色合成。离屏工具有单独的窗口激活策略。录屏依赖 AVFoundation 等框架，温度诊断和图形计时也有 Mac 专用实现；普通构建默认关闭可选诊断。Windows 的实际帧率须在目标机测量。[角色渲染](../native-ui/src/NativeAvatar.cpp) · [离屏入口](../native-ui/preview/ScenePreview.cpp) · [录屏](../native-ui/src/WindowRecorder.mm)

## 6. 安装、签名与升级

七期原生构建及新建升级检查都直接读取六期正式结果，按候选名从产物列表中取唯一匹配的构建摘要。旧升级记录回放使用各自报告保存的证据副本。表中的三份 JSON 随源码提供，二进制安装、运行报告和模型由测试环境另备。

|文件|用途|
|---|---|
|[六期正式结果](evidence/preview-m6-formal-r1-20261117.json)|七期构建和从六期升级时采用的上一版本身份|
|[一期正式结果](evidence/preview-m1-formal-r1-20261102.json)|首次交付已附带的历史结果|
|[性能协议](evidence/moonroom-supplementary-protocol.json)|Node 性能比较工具直接加载的固定输入|

Windows 启动器需核对已采用的候选、清单、文件摘要、签名和进程身份。应拒绝未知文件、逃逸链接、损坏安装及恢复状态不明的工作区。格式拒绝期间，Mac 检查允许启动器的签名校验子进程，包括系统返回的短名 `(codesign)`。宿主和业务后端仍不得趁此启动。Windows 的签名验证应保持同样的边界。[安装验证](../native-ui/preview-runtime.cjs) · [升级检查](../script/registered_run/preview_v4.py)

旧 Electron 的 Mac DMG 打包脚本还会读取、校验并复制 `docs/MACOS-INSTALL.txt`。这份旧安装说明未随本分支交付，复现该打包流程需要另备原件。[打包脚本](../frontend/script/package-macos-dmg.cjs#L193)

## 7. 测试的适用范围

Mac 完整源码的七期基线含 Python 3,537 项、Node 1,171 项、前端 25 项、CTest 20 项和 Qt 测试 3,093 项。Windows 移植要覆盖真实父子进程传钥、数据库解锁与格式拒绝、七组业务界面、前一版本的升级和恢复。Qt 的平台契约测试也需要移植其目录权限、文件身份与管道夹具。

拿到本分支后，以下测试依赖交付范围之外的材料。括号内的行号指向同版本的用例定义，便于定位失败原因。

|测试|所需材料及预期表现|
|---|---|
|`tests/test_registered_run_coverage.py`（15）|一个用例检查七个业务模式关联的 20 份设计说明是否存在。精简树会在第一个缺失文件处失败。|
|`tests/test_registered_run_modes.py`、`test_registered_run_identities.py`、`test_registered_run_stages.py`|三组历史回放需要原始报告。缺报告时部分用例会跳过，部分会报错。把旧报告复制进另一个检出目录时，原始路径和测试文件身份的校验仍可能拒绝。|
|`tests/test_registered_run_registration.py`（913）|回放七组已保存的界面结果时，还要读取各轮独立的 JSON。仅复制汇总报告时会缺少这些输入。|
|`native-ui/tests/test_moonroom_reply_start.py`（239）|两个参数用例分别从旧提交读取记忆和设置引导文件，并比较完整字节。公开历史缺少该提交。|
|`tests/test_registered_run_readonly_evidence.py`（122，夹具在 69 行读取源码）|夹具从旧提交读取修复前的文件校验实现。公开历史缺少该提交，错误发生在用例主体执行前。|
|`native-ui/smoothness-diagnostics.test.cjs`（45、239）|两个用例直接从旧开发提交读取代码。这些提交不在公开分支的祖先中。第 239 行的用例还会校验旧性能参数与原工作目录的绑定。|
|`native-ui/smoothness-diagnostics.test.cjs`（161）|回放早期诊断参数与重试记录，要求原来记录的目录和摘要。|
|`native-ui/smoothness-diagnostics.test.cjs`（100、174）及 `native-ui/smoothness-reading.test.cjs`（5）|三项分别调用已构建的 Mac 诊断程序 `SmoothnessReadingRepro`。纯源码检出缺少该程序。|
|`native-ui/smoothness-phase2.test.cjs`（12、65）|分别读取预先保存的参数与参考截图，后者另用 Pillow 比较图像。源码分支不包含这两份测量材料。|

**Mac 隔离检出的实测结果。** 两边使用相同的 Python 3.12.14、Node 24.19.0 和前端依赖，各有独立的工具目录。测试均附上一份旧报告、性能参数和参考截图。每个测试文件在每棵树上运行一次。

|选择|完整源码|本分支的精简源码|
|---|---|---|
|Python · 128 个文件，3,537 项|3,496 通过，3 失败，38 个夹具错误|3,492 通过，6 失败，39 个夹具错误|
|Node · 41 个文件，1,171 项|1,166 通过，5 失败|1,165 通过，6 失败|

精简树比完整树多出 5 项未通过。1 项 Python 测试缺少设计说明。另 3 项 Python 测试和 1 项 Node 测试需要公开历史里没有的旧提交，分别对应记忆与设置引导的两个参数用例、修复前实现的夹具，以及普通构建对照。另有一项 Node 用例（第 239 行）两边都失败，完整树读到旧代码后遇到参数保留的原目录，精简树先遇到缺失的旧提交。其他未通过项在两边的原因相同。两项依赖性能参数及参考截图的测试（第 12、65 行）因两边都提供了材料而通过。Windows 的系统弹窗、剪贴板、签名、显示效果和性能仍需实机验证。

## 8. 其他文件中指向省略文档的链接

下列 12 处链接指向 9 份省略文件。来源栏指向随本分支提供的文件，目标栏保留文件名，供读者辨认原链接。

|来源|原链接文字|省略的目标|
|---|---|---|
|[README 第 43 行](../README.md#L43)|许可迁移记录|LICENSE-MIGRATION.md|
|[README 第 94 行](../README.md#L94)|macOS 开发环境说明|MACOS-DEVELOPMENT.md|
|[README 第 97 行](../README.md#L97)|macOS 打包说明|MACOS-PACKAGING.md|
|[README 第 102 行](../README.md#L102)|macOS 测试 DMG 验收摘要|MACOS-ACCEPTANCE.md|
|[CREDITS 第 5 行](../CREDITS.md#L5)|迁移说明|LICENSE-MIGRATION.md|
|[CREDITS 第 15 行](../CREDITS.md#L15)|许可证评估|PREVIEW-LICENSE-EVALUATION-20261117.md|
|[CREDITS 第 29 行](../CREDITS.md#L29)|第二阶段记录|LICENSE-MIGRATION-STAGE-TWO.md|
|[CREDITS 第 29 行](../CREDITS.md#L29)|摘要契约|CONVERSATION-SUMMARY.md|
|[CREDITS 第 112 行](../CREDITS.md#L112)|迁移记录|LICENSE-MIGRATION.md|
|[许可证目录 README 第 5 行](../LICENSES_CREDITS/README.md#L5)|`docs/LICENSE-MIGRATION.md`|LICENSE-MIGRATION.md|
|[原生目录 README 第 5 行](../native-ui/README.md#L5)|Claude Code 接手说明|CLAUDE-CODE-HANDOFF.md|
|[登记工具 README 第 3 行](../script/registered_run/README.md#L3)|`docs/PROCESS-RULES.md`|PROCESS-RULES.md|
