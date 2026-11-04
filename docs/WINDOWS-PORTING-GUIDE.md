# Windows 移植指南（W7，Mac 实现交接稿）

本指南给在 Windows 上移植 Reverie 的合作开发者使用。我方只在 Mac 上实现和验证；Windows 移植、构建、系统集成及打包由合作开发者负责。下文没有已验证的 Windows 命令，也不表示 Windows 已可运行。

**关于这个分支：**这是从内部开发分支精简出来的交接分支，只有一个提交，代码与内部提交 `499119c` 相同。`docs/` 只保留本指南和代码依赖的两个证据文件；内部过程文档、测试记录和提交历史都没有带上，所以 README 等处指向 `docs/` 的部分链接会失效。文中「W7」指这次 Windows 移植交接工作，「二期正式 r2」指内部验证通过的 Mac 基线。

## 一、范围、分工与基线

- 当前产品是 Qt 原生宿主加 Python 后端，旧 Electron 文件仍在仓库中，不能把旧 Windows 支持当成当前 Qt 宿主已经支持 Windows。
- 当前已签收身份为二期正式 r2 的 6367 项。移植应保留全部原身份的行为，不把新增测试代替原回归。
- preview v4 的升级检查仍绑定一期正式版本，和「用二期作为当前签收比较基线」是两回事。不要自行改 `CMakeLists.txt` 的 `REVERIE_PREVIOUS_RESULT` 或旧后端绑定。
- Windows 上的问题请反馈给项目维护者。

## 二、工具链与构建地图

仓库目前固定 Qt 6.11.2，使用 Quick、QuickControls2、Network、OpenGL、Test、ShaderTools 和 GuiPrivate；CMake 最低 3.24，C++20。现有工程还固定 OBJCXX、arm64、macOS 14 及多种 framework。这些是 Mac 构建事实，Windows 的编译器、Qt 二进制包和原生 Python wheel 必须由合作方实测选择。

Python 项目要求 3.12，本地 Mac 工具链固定 3.12.14；`requirements-runtime.lock` 固定 `sqlcipher3==0.6.2`、`sqlite-vec==0.1.9` 等依赖。不要因 Windows 安装困难把 SQLCipher 换成明文 SQLite。Node 用于前端逻辑生成、安装完整性校验和检查工具，CMake 也会读取 Node 可执行文件的哈希，不能仅安装 Qt 就忽略这些输入。

需要合作方处理的 CMake 项包括：`.mm` 文件、`-fobjc-arc`、Security／Foundation／OpenGL／AVFoundation／CoreVideo／CoreMedia／AppKit 链接、Mac plist、arm64 Core 路径、工具程序路径及哈希绑定。W7 只把新通道文件和测试加入现有 Mac 工程，没有写平台选择或 Windows 实现。

来源：[`native-ui/CMakeLists.txt`](../native-ui/CMakeLists.txt)、[`config/qt-macos-toolchain.json`](../config/qt-macos-toolchain.json)、[`config/macos-toolchain.json`](../config/macos-toolchain.json)、[`pyproject.toml`](../pyproject.toml)、[`requirements-runtime.lock`](../requirements-runtime.lock)。

## 三、两个待实现的接口与传钥合同

### 存储及服务凭据：沿用 Keychain.h

[`Keychain.h`](../native-ui/src/Keychain.h) 只依赖 Qt，已经是接口；[`Keychain.mm`](../native-ui/src/Keychain.mm) 是现有 Mac 实现。W7 不改这两个文件，不添加转发层。Windows 方应提供同样声明的实现，保留以下语义：

- 存储钥恰好 32 字节，只在系统凭据保护及进程内存中使用。账户绑定传入根路径字符串的 UTF-8 SHA-256；同一目录的不同字符串不保证是同一个账户。
- Local 与 Preview 的存储、provider 服务共四个命名空间；两域不互读。Mac 服务名前缀分别是 `com.muhe.reverie.qt.local` 和 `com.muhe.reverie.qt.preview`，后缀为 `storage.v1`、`credentials.v1`。
- 已有数据库而钥缺失时拒绝，不生成替代钥。当前扫描口径是根下文件名含 `.sqlite` 或 `.db`，不在移植时暗改这个口径。
- provider 记录保留 `schema/binding/apiKey/writeId`；无记录为 nullopt，写后可完整读回，重复 clear 安全。binding 是 `llm\0provider\0base_url` 的摘要，不能把已存钥发送到另一个服务地址。
- 保留现有错误码以及失败／未知状态的读回合同。Mac 拒绝访问、坏存储钥长度、随机数生成失败和系统写入失败目前没有新契约测试的真实故障覆盖；这些仍是 Windows 必须守住的合同，不能写作我方已测。
- 测试清理仍有范围保护。Preview 删除只接受合法 `CleanupTarget`，不能新增任意账户删除入口。

### 传钥：StorageKeyChannel

[`StorageKeyChannel.h`](../native-ui/src/StorageKeyChannel.h) 不暴露描述符，现有实现是 [`StorageKeyChannelPosix.cpp`](../native-ui/src/StorageKeyChannelPosix.cpp)：

1. 构造创建匿名管道，失败抛调用者指定的原错误码。
2. `configureChild(QProcess&)` 在原时点装配继承通道；Mac 子进程关闭写端，将读端映射到 fd 3，清除 close-on-exec。
3. 调用者仍自己设置 `REVERIE_STORAGE_KEY_FD=3`，之后 start；`sendAndClose` 关闭父读端，写原始钥，关闭父写端并返回写入数量。
4. 调用者立即清零钥缓冲，按原错误码检查写入量。析构只关闭仍持有的端点。

三处调用者为 `RuntimeBridge.cpp`、`main.cpp` 的性能造数、`tests/PreviewUpgradeCheck.cpp`。它们各自原环境、错误码及调用顺序保持；升级检查仍在写入之后才 `waitForStarted`。子进程回调只做原来的 close／dup2／fcntl，不分配内存，**仍未检查 dup2／fcntl 的返回值**；不要宣称 W7 修复了这一点。

通道只传存储钥，不承担普通 stdio、provider API key 或桥接鉴权。`REVERIE_BRIDGE_SECRET` 是另一份父子鉴权随机值，目前明确存在子进程环境中；「不进环境」只适用于存储钥。

### Python 读端及 Windows 分支要求

[`encrypted_sqlite.py`](../src/storage/encrypted_sqlite.py) 在任何持久库打开前 pop bootstrap 环境项；现 POSIX 分支只接受十进制 fd 3–255，二进制读至 EOF 或第 33 字节。只有恰好 32 字节可安装；异常、短或长数据均拒绝，关闭读端并清零临时 bytearray。不同已安装钥拒绝覆盖；SQLCipher 不可用时不得明文降级。

Windows HANDLE 与 CRT fd 不是同一表示。合作方须共同定义 C++ 通道与 Python 分支的非秘密定位、继承、二进制读取、所有权和关闭合同，不能直接把任意 HANDLE 塞进 Mac 的 fd 校验，也不能为 Windows 放宽 Mac 合同。钥不得改走命令行、环境值、临时文件或公开通道。父写端写完关闭，读端不能继承给无关后代；真实父子进程联验是必需的。现读函数本身没有超时，仍依赖宿主启动期限和进程回收链，不得放宽期限。

**重要的夹具移植量：**9 个 `native-ui/tests/p*_backend_bootstrap.py` 都写死 `REVERIE_STORAGE_KEY_FD == "3"` 并检查 `os.fstat(3)` 是 FIFO；`native-ui/perf-fixtures.py` 同样如此。Windows 上须适配这些夹具以及 Python 消费端，不能仅实现 C++ 类就宣称业务 GUI 已可运行。来源包括 `p0_backend_bootstrap.py` 的 bootstrap 检查以及各 persona／memory／settings／entry／regex／injection／restore／profile 引导。

## 四、工作区、格式、快照与恢复

W5 已有 [`PreviewPlatform.h`](../native-ui/src/PreviewPlatform.h)，其文件身份、私有目录、锁、no-follow、链接策略、排他发布、重命名及退出通知供上层调用。但 `.cpp` 仍无条件使用 POSIX 头与调用，局部 Apple 分支不等于已经有 Windows 版本。

合作方须等价实现目录所有权／私有访问、同一工作区单实例锁、稳定文件身份、特殊文件拒绝、按内容复制硬链接、持久化、替换中断恢复和退出通知。不要以是否存在 PID 文件代替内核锁，不删除未知恢复记录来强行启动。恢复前快照、升级快照保留规则、数据格式号高于宿主即拒绝、恢复后的候选记录与新编号，都属于共用合同。

新 `platform-contract` 的夹具准备／清理也依赖 `PreviewWorkspace` 和 `PreviewPlatform`，还用 POSIX 目录身份、权限和端点观察。Windows 上要先移植这些依赖或调整夹具，不能将 Mac 夹具失败当成接口断言可跳过。测试正文通过 Keychain.h／StorageKeyChannel.h 验证性质，夹具集中在新测试文件一处。

来源：[`PreviewWorkspace.cpp`](../native-ui/src/PreviewWorkspace.cpp)、[`PreviewPlatform.cpp`](../native-ui/src/PreviewPlatform.cpp)、[`PreviewSnapshot.cpp`](../native-ui/src/PreviewSnapshot.cpp)、[`PreviewRestore.cpp`](../native-ui/src/PreviewRestore.cpp)、[`PreviewDataFormat.cpp`](../native-ui/src/PreviewDataFormat.cpp)。

## 五、图形、离屏工具和资产

`main.cpp`／`preview/ScenePreview.cpp` 当前显式使用 OpenGL 2.1；`NativeAvatar.cpp` 使用 Cubism 的 OpenGL 渲染链。Windows 的显卡驱动和 Qt 默认图形后端能否与之配合必须实测。是否使用 D3D11 及对应 Cubism 渲染器由合作方决定，我方没有替换或验证。

`preview/PreviewActivation.mm` 只有一条 AppKit Prohibited 设置，只由离屏 PNG 工具 ScenePreview 使用；它不显示窗口、不启动后端。Windows 方可以提供空实现或不构建该工具；不要把此策略应用到日常产品窗口。主程序与测试的窗口激活是 Qt 的 `requestActivate()`。

还须处理两个编进主程序的 Mac 文件：`src/WindowRecorder.mm` 使用 AVFoundation／CoreVideo／Foundation，main 会创建录制对象；`tests/HeaderFrameThermal.mm` 负责 Mac 发热状态诊断。它们不用 AppKit，但仍使直接 Windows 构建不可行。录制及性能诊断可另做等价适配，不能留着无法链接的文件。

来源：[`NativeAvatar.cpp`](../native-ui/src/NativeAvatar.cpp)、[`ScenePreview.cpp`](../native-ui/preview/ScenePreview.cpp)、[`WindowRecorder.mm`](../native-ui/src/WindowRecorder.mm)、[`HeaderFrameThermal.mm`](../native-ui/tests/HeaderFrameThermal.mm)、CMake。

## 六、安装、启动与完整性链

当前 `script/preview-qt-macos.sh`、`native-ui/preview-runtime.cjs`、`script/build-qt-macos.cjs` 和 `native-ui/build-record.cjs` 是 Mac 实现。安装复制源、Python、Node 与候选，并保留构建输入、清单和签名核验；有些 Qt／Core／shader 输入仍按记录引用外部位置。Windows 不应照抄 Mac 绝对路径或 codesign 参数，而应建立自己的可信依赖、签名和文件清单链。

必须保留：只安装已采用的正常候选；启动前核对安装与依赖；除精确名 `.DS_Store` 的普通文件外，多出、缺少或变化仍拒绝；不放宽链接／特殊文件保护；工作区私有；安装与数据工作区分离；恢复状态不明拒绝启动。现本地工具的 `ps`／进程出生身份和设备移除查询同样需要 Windows 等价物。

W7 不改构建脚本和性能工具；登记工具只在定向运行的目标表里加了 `platform-contract` 一行。`check-performance.cjs` 的 workload 清单保持现状，没有加入 StorageKeyChannel；它不是完整产品输入清单，不能据此宣称已经审计全部新实现。

## 七、不可削弱的安全及身份合同

- 父子鉴权、协议版本、私有控制帧与进程身份；不能把 renderer 可发送命令扩大为特权控制。
- SQLCipher、不接受钥丢失后自动替换、错误钥不得重建已有库。
- persona／message ID、epoch／generation、请求关联、取消、迟到结果拒绝；不得因平台异步差异放宽。
- 整档 revision CAS、冲突保留草稿、写锁、提交结果未知与明确拒绝的区别。
- 诊断只记获准的有界元数据；不能记录钥、正文或私密模型内容。

来源：[`stdio_bridge.py`](../src/bridge/stdio_bridge.py)、[`RuntimeBridge.cpp`](../native-ui/src/RuntimeBridge.cpp)、[`archive/store.py`](../src/archive/store.py)、[`encrypted_sqlite.py`](../src/storage/encrypted_sqlite.py) 及其已签收测试。

## 八、测试地图与 Windows 签收建议

Mac 新契约目标为 `platform-contract`，在内部 Mac 本地验证中定向和完整单测（6379 项）都通过；各性质的实际覆盖和限制如下，不能推广到 Windows：

| 性质 | Mac 验证途径／限制 |
|---|---|
| 新根 32 字节、同根重读、两根与两域隔离 | 新目标同一进程创建／读取；不输出钥或其摘要 |
| 已有 `.sqlite`／`.db` 缺钥拒绝、原库字节不变 | 新目标真实临时根，不向真实工作区写入 |
| provider 空项、完整记录往返、重复 clear | 新目标；桥接目的地／回执／未知状态仍由原 RuntimeBridgeTest 覆盖 |
| 32 字节、EOF、argv/env 无存储钥、两通道不串钥 | 新目标自己的真实子进程；两通道先后建立，第一个端点关闭后才建立第二个；没有验证两套端点同时存在时的继承范围。不依赖 Python，不改变真实后端的 GUI 联验 |
| 启动失败与端点释放 | 新目标真实不存在的程序路径及析构端点观察，无故障注入 |
| Preview 清理不留残留 | 先取得合法 CleanupTarget，原路径创建；删除后放 `.db` 再读须缺钥拒绝；最后只查本次服务／账户属性，不枚举钥匙串或读取内容 |
| 拒绝访问、坏长度、系统读写失败、授权弹窗 | 未用新目标制造；Windows 必须自行验证，不把它们写成我方已测 |

现有 PreviewPlatformTest、PreviewWorkspaceTest、PreviewSnapshotTest、PreviewRestoreTest、PreviewEventsTest、PreviewDataFormatTest 覆盖工作区及恢复保护；其中造文件／权限／身份的夹具有 POSIX 假设。RuntimeBridge 的 FakeKeyStore 验证状态机，不等于真实系统凭据测试。`tests/test_encrypted_storage.py` 的 os.pipe 测试也不等于真实 Windows HANDLE 联验。

`RuntimeBridgeTest` 不调用 `RuntimeBridge::start()`，不能证明传钥通道。三处调用在内部 Mac 验证中的覆盖如下：

| 调用处 | 真正经过该调用的运行 | W7本轮覆盖与边界 |
|---|---|---|
| `tests/PreviewUpgradeCheck.cpp` | preview v4的升级检查 | 实际运行并通过，含真实 Python 后端 |
| `RuntimeBridge::start()` | 业务GUI模式启动真实后端、读取fd 3 | 七个业务 GUI 各两轮实际通过；RuntimeBridgeTest 不能替代 |
| `main.cpp`性能造数 | `check-performance.cjs`、`check-header-frame-local.cjs` | 本轮不运行性能造数，只有代码对照，未验证这处实际调用 |

**在这个分支上跑测试时：**下面这些项在这个分支上不会通过，不是移植造成的：

- `tests/test_registered_run_coverage.py::test_gui_coverage_records_all_seven_mode_options_and_real_references`：它检查内部方向文档是否存在，而这些文档没有带上。
- 40 项登记工具测试（`tests/test_registered_run_modes.py` 38 项，`tests/test_registered_run_identities.py`、`tests/test_registered_run_stages.py` 各 1 项）：它们回放本机保存的旧运行报告（`.tools/reports/`），报告不随代码提供。

除此之外，这个分支在 Mac 隔离目录里的对照结果是：Python 3027 项中其余 2986 项通过，Node 675 项全部通过。当时提供了 Mac 上的 Python 环境和本机工具链；QTest、前端单测和 GUI 没有在这个分支上重跑，它们的结果来自内部提交，非 `docs/` 文件与该提交逐字节相同。Windows 上没有验证。

建议 Windows 完成：锁定依赖的后端完整单测；上述真实平台接口契约；保留输入、断言及原时限的七个业务 GUI 模式；preview v4 的升级、恢复、回退和格式反例；安装／签名／路径／进程／清理检查。各模式计数和旧版本绑定取正式配置与公开结果，不能以旧 Electron 或九月 CI 结果代替。Mac 的属性工具、窗口录制、进程身份和设备查询由合作方给出等价检查链。

## 九、限制、禁止交付物与反馈

Windows 的构建、运行、性能、系统弹窗和分发均未由我方验证。文中的方法及版本来自当前仓库，不保证 Windows 对应包可用。

Live2D Core、SDK 和模型只在既有本地授权范围使用，不随代码交付；合作方须按自己的授权获取。密钥、数据库、真实工作区、私密日志以及本机安装／构建缓存同样不交付。仓库出现某个本地依赖路径不等于获得分发许可。

合作方实测问题请反馈给项目维护者，区分阻断／重要／一般，保留失败原文、版本和必要的脱敏元数据。本指南的可用性仍待合作方使用后反馈。
