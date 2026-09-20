# macOS 开发环境

本流程在 Apple Silicon Mac 上准备 Reverie 的独立开发环境，启动 Electron 桌面与 Python 后端，并保存逐项验收报告。当前目标是源码开发与本机验证；不生成 `.app`、DMG、签名或公证发行包。

## 初始化

在仓库根目录执行：

```bash
bash script/setup-macos.sh
```

解释器与工具安装在仓库的 `.tools/`，Python 包安装在 `.venv/`，前端依赖安装在 `frontend/node_modules/`。流程不修改全局 Python、Node、pnpm、Homebrew 或 shell 配置，也不使用 Codex 缓存解释器作为项目运行时。

工具链固定为 CPython 3.12.14 arm64、Node 24.19.0 arm64、pnpm 11.7.0 和 uv 0.12.17；来源与校验信息见 `config/macos-toolchain.json`。Python 使用 `requirements-macos-arm64.lock` 与 `requirements-macos-arm64-dev.lock`；前端使用 `frontend/pnpm-lock.yaml`。Windows 的 `requirements-runtime.lock` 仍专用于 Windows wheel。

日常初始化严格使用现有锁，不重新解析依赖。维护者有意升级依赖时才执行 `bash script/lock-macos.sh`，生成目标平台精确 wheel 哈希锁；检查锁文件差异后重新初始化并完成全部验收。

开发依赖包括 pytest、Hypothesis、Playwright、pytest-playwright、Textual 和能力清单测试所需的 PyYAML。安装 Python 包不会作为本流程的一部分下载浏览器；本地 embedding 模型、Torch 和 sentence-transformers 也不在此初始化范围。模型缺失时，后端保留真实的词汇检索降级状态。

`.venv` 依赖 `.tools` 内的基础解释器，不能单独搬走。移动仓库、删除 `.tools` 或更换架构后，需要重建环境。初始化遇到不兼容的旧环境会明确停止；先自行保留或移走旧 `.venv`，再重新初始化，不会自动删除它。

前端 vendored Live2D renderer 的两份 MIT 发行文件按 `UPSTREAM.json` 校验。初始化会离线补齐 pnpm 旧工作区缓存中缺失的文件，已有文件哈希冲突则报错；不会下载 Cubism Core 或角色模型。pnpm 11 的 overrides 配置位于工作区 YAML，保留原锁定值；与本流程无关的 Windows Squirrel 安装脚本明确禁用。

## 检查与报告

先执行环境检查：

```bash
bash script/check-macos.sh --env-only
```

它检查工具版本、arm64 架构、Python 的 prefix/base-prefix、包版本与导入路径、依赖一致性，并实际验证 SQLCipher 与 sqlite-vec：临时建库，在新的 Python 进程中解密重读，拒绝错误密钥，确认普通 SQLite 无法读取，再执行向量近邻查询。SQLCipher 缺失或不能加载 sqlite-vec 都算失败。

完整验收：

```bash
bash script/check-macos.sh
```

完整检查包含上述所有项目，以及完整 pytest、前端 typecheck/test/build、生产 framed-stdio bridge smoke、`pnpm smoke:desktop:core`。桥接检查显式传入项目 `.venv` 解释器。桌面检查会启动本机 Electron，需要可用的图形会话。

每次检查保存到 `.tools/reports/check-<时间>-<进程号>/`。`summary.json` 记录工具链版本、三个依赖锁的 SHA-256，以及每项状态、退出码、耗时、命令与日志路径；Python 环境和加密存储另有 JSON 明细。任一项目失败或超时，检查整体返回非零；不会将缺工具、缺 native 库或缺 smoke 命令视作通过。

检查数据通过 `REVERIE_DATA_DIR` 隔离到报告目录的 `scratch/`，并设置 `PYTHON_DOTENV_DISABLED=1` 防止读取用户的根目录 `.env`。原生加密检查使用临时数据与随机密钥，密钥只经继承管道传给子进程，不进入参数、报告或磁盘文件。报告保留测试日志与合成测试数据，便于复核；不要将“env-only 通过”当作完整桌面验收。

检查不会下载 embedding 模型或浏览器。pytest 最长 30 分钟，每项前端任务最长 20 分钟，framed bridge 最长 2 分钟，桌面核心 smoke 最长 5 分钟；超时会终止对应进程组并记录失败。

## 启动开发桌面

```bash
bash script/dev-macos.sh
```

启动脚本使用同一套项目工具链和 `.venv`。模型供应商与凭据通过应用现有设置配置；启动成功并不代表远端模型已配置或联网请求已验证。

启动时先独立检查项目 Python。首次检查超过 10 秒时，只对同一虚拟环境入口重试一次，重试限时 30 秒；权限错误、非零退出或异常终止不会自动重试，也不会回退到系统 Python。错误会显示实际原因、退出码或信号，并将脱敏诊断保存到 `.tools/reports/python-startup/`。`latest.json` 是最近一次检查，`latest-failure.json` 保留最近一次失败；诊断不包含环境变量或原始标准输出。

Vite 最多等待 120 秒，较慢时每 10 秒提示进度，必须同时收到本次子进程的就绪消息和 HTTP 成功响应才会打开 Electron。macOS 开发模式的 Python 后端也有 120 秒初始化时间，避免加载依赖时被反复中断；完成 V4 鉴权和连接后才会记录 `Local backend authenticated: protocol v4`。发行模式及其他平台继续使用原来的握手时限和校验规则。

冷启动可能在读取依赖文件时较慢；仅出现启动检查超时不代表虚拟环境已经损坏，不要因此先删除环境或重装。应用内退出或 ⌘Q 会结束本次 Electron 会话并清理本次 Vite，之后可再次运行同一启动命令。

若要手动执行单项命令，先在当前 shell 引入局部环境：

```bash
source script/macos-common.sh
REVERIE_DATA_DIR="$REVERIE_ROOT/.tools/manual-test-data" "$REVERIE_PYTHON" -m pytest
"$REVERIE_NODE" "$REVERIE_PNPM" --dir frontend typecheck
```

局部环境仅影响当前 shell 及其子进程。普通 Python 业务测试使用隔离的临时数据；需要完整、统一证据时仍使用 `check-macos.sh`。
