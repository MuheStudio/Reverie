# macOS arm64 独立核心应用与测试 DMG

本入口生成 `Reverie macOS Test.app`，采用现有 Electron + React + CPython 架构，保留 V4 framed-stdio、父进程鉴权、匿名管道传钥及 SQLCipher 强制加密。它是本机核心应用验收候选，不是正式分发、自动更新或公证发行版。

## 构建与候选

在仓库根目录运行：

```bash
./script/package-macos.sh
```

根目录入口直接调用已安装的固定 Node/uv/Electron/electron-builder，不运行开发环境 setup，不升级锁定依赖，也不触发 pnpm 11 的脚本执行前自动安装。Windows 的配置、staging 与构建命令保持独立。

构建从 `config/macos-toolchain.json` 的 CPython 3.12.14 / 20260901 arm64 归档重新校验、解包，按 `requirements-macos-arm64.lock` 安装 47 个运行依赖；不复制 `.venv` 或开发工具链。只允许哈希匹配的 wheel。输入轮子含 universal2 时，仅提取 arm64，并在运行时清单记录派生变换；这不代表提供 Universal 支持。外部构建目录的 Mach-O rpath 会被移除并重新检查所有实际库依赖，不通过放宽外链检查掩盖缺库。

最低系统声明为 macOS 14（由锁定的原生依赖要求决定），实际系统覆盖以验收报告为准。许可证收集直接遍历本地已安装生产依赖，不依赖 pnpm 缓存索引；上游包若只有许可证元数据而未附文本，清单明确标记，不补造许可文件。

前端以生产模式构建，打入完整性校验的 ASAR，运行时使用 `reverie-app://app/` 资源协议，不启动 Vite。源码候选清单覆盖当前工作树中的源码及构建输入（包括未提交的启动诊断和有限重试修复），记录每个文件的 SHA-256；打包期间候选变化会使构建失败。

默认产物：

- `~/Library/Developer/Reverie/LocalBuilds/<仓库路径摘要>/mac-arm64/Reverie macOS Test.app`
- `frontend/release-macos/source-candidate.json`
- `frontend/release-macos/macos-build.json`
- 包内 `Contents/Resources/python/reverie-python-runtime.json`

实际应用绝对路径同时写入 `frontend/.package-smoke-macos/latest-package.json`，默认验证入口自动读取。应用位于本机专用构建目录，不安装到 `/Applications`；不同仓库路径使用不同子目录，以免互相覆盖。

同一个 `LocalBuilds/<仓库路径摘要>` 下的 `.macos-installer-app` 与 `.macos-installer-resources` 仅为本轮生成的 staging，重复构建会重新生成它们。生产 staging 也位于同步目录之外，避免解释器数千个小文件受 File Provider 读取延迟影响。现有用户数据和 Windows staging 不在该清理范围内。

生产下载及 uv 缓存也使用该目录下的 `cache`。首次迁移只复用旧缓存中的压缩归档与 wheel，并重新校验全部哈希；不复制旧解压缓存、开发虚拟环境或工具链。

迭代本地应用壳时可用 `./script/package-macos.sh --reuse-runtime`，但仅复用来源归档、运行依赖锁及完整签名前文件清单全部匹配的独立 staging，并重新运行原生审计。它不接受开发虚拟环境，也不会跳过候选校验或应用包重建；任何输入或文件变更都拒绝复用。

## 从已验收应用制作 DMG

在已有成功应用构建及人工验收后运行：

```bash
./script/package-macos-dmg.sh
# 或指定应用、该应用的成功构建清单和输出目录：
./script/package-macos-dmg.sh --app '/path/Reverie macOS Test.app' --manifest '/path/macos-build.json' --out '/path/本地构建/dmg'
```

入口使用固定 electron-builder 26.15.6 的 `--prepackaged` 路线，将已验收应用的临时副本封装为 HFS+、UDZO 压缩镜像。它不重新构建或重签应用，不依赖生产 staging，不复制开发环境，也不启动 Vite。独立 DMG 配置关闭发布、签名身份自动发现和更新元数据生成；builder 配套 arm64 DMG 工具的版本、下载来源和校验值写入清单，缓存留在专用本机构建目录。

窗口采用浅色布局，包含 `Reverie macOS Test.app`、指向 `/Applications` 的 `Applications` 快捷方式和由 `docs/MACOS-INSTALL.txt` 提供的中文 `安装说明.txt`。DMG 自身不签名、不公证；应用仍保留 `com.muhe.reverie.macos.test` 身份及原有 ad-hoc 签名。拖拽安装不会把测试身份转换为正式版。

默认输出位于 `~/Library/Developer/Reverie/LocalBuilds/<仓库路径摘要>/dmg/`，包含：

- `Reverie-macOS-Test-0.5.5-arm64-<应用摘要前12位>.dmg`。
- 同名 `.dmg.sha256` 校验文件，以及同名去掉 `.dmg` 后的 `.json` 构建清单。
- `frontend/.package-smoke-macos/latest-dmg.json` 成功指针，记录 DMG、DMG 构建清单和原应用构建清单的位置。

应用摘要来自成功应用构建清单中的签名后完整文件清单。构建前后及镜像内应用均校验身份、文件、链接与签名，保证封装没有改变原候选。已有同名产物仅在内容和清单完整匹配时复用；冲突会报错，不覆盖未知文件。失败尝试不能更新成功指针。显式输出目录也应位于 Documents、Desktop 等同步目录之外。

如果源码变化仅涉及未入包的测试、DMG 工具或文档，报告分别记录原应用源码候选和这些验证修订。涉及包内代码或构建输入的行为修复则须重建应用并重新验收，不能把旧候选的人工验收结论直接用于新应用。

## 运行布局与安全边界

| 路径 | 用途 |
|---|---|
| `Contents/Resources/app.asar` | Electron 主进程、隔离 preload、编译后的 React 资源 |
| `Contents/Resources/python/bin/python3.12` | 独立真实解释器入口；不是虚拟环境或符号链接入口 |
| `Contents/Resources/python/lib` | 标准库、47 个运行依赖及包内原生扩展 |
| `Contents/Resources/src` | 原有 production source 边界下的 Python 业务源码 |
| `Contents/Resources/data` | 由代码生成的空白初始配置；不从开发者现有数据复制 |
| `Contents/Resources/TEST-BUILD-DO-NOT-RELEASE.json` | 绑定本地测试 bundle 身份的标记 |

发行入口只接受包内解释器，独立检查 `sys.prefix == sys.base_prefix == 包内 Python 根目录`，不套用开发 venv 条件。实际子进程使用 `-I -B`，忽略环境 Python 路径与用户 site，禁止写字节码；不回退系统 Python、`.venv` 或 Codex 缓存。原生依赖必须解析至包内或 macOS 系统库。

测试身份为 `com.muhe.reverie.macos.test`，默认应用名及数据目录为 `Reverie macOS Test`，与已有 Reverie 数据分离。验证器进一步使用临时隔离目录。只有测试标记、架构和实际 bundle identifier 一致时，才接受绝对的 `REVERIE_TEST_USER_DATA_DIR`；数据目录不得位于应用包内。应用控制的 session/cache/tmp/log/crash 路径也在隔离目录中。

密钥仍由 Electron `safeStorage` 经 macOS 钥匙串保护，原始数据库密钥只通过继承的额外匿名管道传递。已有受保护密钥损坏、数据库解密失败，或已有数据库但密钥文件缺失时，macOS 候选拒绝继续；不降级明文，不静默生成新身份或重置数据。日志记录阶段、时间和错误类别，不记录密钥。

生产模式保留原有握手时限作为初始基线，以应用包实测阶段耗时判断是否存在问题；不直接继承 macOS 开发模式的 120 秒等待。窗口出现、解释器启动、V4 鉴权完成及界面可用是不同阶段，报告分别记录。

已有源码启动修复继续保留：开发解释器探测只对超时重试一次并写入诊断，Vite 等待有进度和明确上限，macOS 开发后端初始化使用独立等待配置。上述开发设置不会改变包内解释器选择及生产 20 秒预检/握手限制。

## 本地签名与分发边界

构建明确使用 electron-builder 的 ad-hoc 本地测试签名，并保留其默认 macOS entitlements 和现有生产 Electron fuses：禁用 RunAsNode、NODE_OPTIONS、Node inspector 参数及 file 协议额外权限，启用 ASAR 完整性检查、仅加载 ASAR 和 cookie 加密。测试不另造可调试包、不放宽 CSP/IPC/鉴权来获得通过。

本地 ad-hoc 签名不具有 Developer ID 团队身份。默认 builder 的 hardened-runtime entitlements 包含 JIT、未签名可执行内存和 library-validation 例外；实际签名与 entitlements 写入构建清单。这些是本地签名配置的证据，不是正式分发安全评审、公证、Gatekeeper 接受或跨版本钥匙串兼容通过的证据。正式签名身份、最小化发布 entitlements 与跨版本密钥访问另行验收。

嵌套 Mach-O 清单覆盖解释器、标准库扩展、第三方 `.so/.dylib`、Electron 框架与 helper。先处理运行时架构及库路径，再由 builder 从内到外签名；最终独立检查原生签名、整个 `.app` 严格签名和 fuses。运行时清单的文件哈希标明签名前阶段，外部构建清单记录签名后的最终整包文件哈希，两者不能混用。

签名在系统临时构建目录中完成，随后复制签名后的应用到上述本机构建目录并重新校验。本机实测 Documents 的 File Provider 会持续重新附加 Finder 元数据，复制回那里也会导致严格签名验证失败，因此最终 `.app` 也必须留在同步目录之外。清理仅限临时生成包中的 `com.apple.FinderInfo` 与 `com.apple.ResourceFork`，并记录清单，不删除 quarantine 或其他安全属性，也不修改已安装的源 Electron。

## 应用包验收

```bash
./script/check-macos-package.sh
# 或指定最终应用：
./script/check-macos-package.sh --app '/path/含空格 中文/Reverie macOS Test.app' --manifest '/path/macos-build.json'
```

验证入口先核对成功构建清单、包内源码候选标识及最终文件哈希，拒绝仅残留在磁盘上的失败构建。它使用与最终产物相同的应用，不依赖源码运行模式，在仓库外的中文、空格路径准备只读测试介质；此临时镜像仅用于验证只读运行，不作为分发包交付。应用进程从仓库外启动，只提供系统 PATH，并清理开发注入环境。

验收覆盖包内原生库真实加载、SQLCipher/sqlite-vec、生产资源协议与 preload、V4 鉴权、本机模拟模型实际 UI 聊天、至少三轮正常退出和同数据重启、消息内容与 ID 恢复、取钥复用、进程清理及整包前后哈希不变。三类负向案例仅对合成测试数据副本破坏 vault、破坏加密页，或删除 vault 并保留数据库，要求拒绝启动/解密且不重建密钥、不覆盖原有测试数据库；不会读取、复制或修改用户已有聊天。

证据保存在 `frontend/.package-smoke-macos/`。同一签名候选在本机钥匙串读写和重启复用成功，只能证明该候选的行为，不能推导跨签名、跨版本或其他用户账户也通过。

源码完整回归仍使用 `./script/check-macos.sh`，其报告在 `.tools/reports/`。检查器校验安装锁一致性并直接运行完整 TypeScript、Node/Vitest、Vite 和桌面测试工具，不隐式安装或修复依赖。交付时应同时查看源码回归、应用包报告和候选哈希：源码通过不能代替应用包通过，开发模式通过也不能代替只读独立应用通过。Live2D 模型、GPT-SoVITS 自动运行时、Intel/Universal、真实付费模型、自动更新、发布与公证均不在本轮范围。

## 最终 DMG 验收与提交

```bash
./script/check-macos-dmg.sh
# 或显式绑定 DMG、DMG 清单及原应用清单：
./script/check-macos-dmg.sh --dmg '/path/Reverie-macOS-Test-0.5.5-arm64-摘要.dmg' --manifest '/path/Reverie-macOS-Test-0.5.5-arm64-摘要.json' --app-manifest '/path/macos-build.json' --out '/path/验收报告'
```

默认入口读取成功 DMG 指针，先核对镜像 SHA-256、构建清单和原应用候选，再检查镜像完整性及只读挂载。验收直接运行最终 DMG 内的应用，检查窗口布局、Applications 链接和安装说明；然后复制到仓库外含中文和空格的临时安装目录，卸载 DMG，再运行复制后的应用。此流程不以另一张临时镜像代替交付 DMG，不写入真实 `/Applications`。

两处运行共用同一隔离合成数据，验证搬移后的取钥、聊天和消息 ID 恢复；至少三轮正常退出与重启及三类加密存储拒绝案例继续执行。包内解释器、原生库、实际 SQLCipher/sqlite-vec、启动分阶段耗时、包内容不变、进程和挂载清理分别留证。不修改已有用户数据，不移除 quarantine，也不以放宽生产鉴权或加密策略取得通过。运行失败时保留脱敏诊断，并在报告中区分失败退出和成功就绪后的正常退出。

仓库仅提交构建与验证入口、固定来源清单、必要源码及测试修复、许可证和精简脱敏验收摘要。应用、DMG、环境、缓存、staging、原始日志和用户数据均不提交；`frontend/vendor/pixi-live2d-display/dist/` 是带上游来源和现有 MIT 许可证的运行依赖源码，必须保留。

按必要共享修复、macOS 开发与独立应用支持、DMG 与交付文档组织本地提交。推送仅允许普通推送至 `origin/codex/Mac`；写权限缺失时保留本地提交，远端分歧时停止，不强推或自行更换远端。推送成功后手动运行现有 Windows quality gate，核对实际提交 SHA。macOS 源码测试不能替代 Windows CI；尚未运行的 CI 必须明确标为未验证。本流程不创建 PR、标签、Release，也不合并 main。

## 同步目录读取异常

若出现异常长的导入等待、模块读成空对象或 `Incomplete or changing build input`，先用 `ls -lO /具体文件` 检查是否标记为 `dataless`。本机已遇到占位文件元数据有长度但读取不完整的情况；这不能直接归因于依赖版本或业务逻辑。构建输入及许可证读取会拒绝短读，不生成看似成功的清单。

可在 Finder 对已有构建文件使用下载操作，或对确认属于 CloudDocs 的具体文件执行 `brctl download '/具体文件'`，等待 `dataless` 消失且完整读取成功后重试。不要把目录命令成功当作所有子文件已下载；不应通过清空环境、升级依赖或放宽测试超时解决这一问题。本轮的恢复仅使原有工具/依赖文件重新可读，没有重建开发环境。
