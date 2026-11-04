# 本地迭代与登记运行

唯一规则出处是 [`docs/PROCESS-RULES.md`](../../docs/PROCESS-RULES.md)。本工具不授予运行权限；本地授权与逐次登记授权分开。所有命令可用 `.venv/bin/python -I -B script/registered_run/cli.py` 调用。

## 结构

- `engine.py`：共享串行阶段、额度、截止、进程组清理和兼容 `run_ledger_facts.py` 的台账。
- `state.py`、`source.py`、`isolation.py`：授权、全局互斥、持久活动标记、临时 Git 索引源码快照和独有隔离目录。
- `stages.py`：从数据配置生成固定 argv，不执行配置中的任意命令字符串。
- `catalog.py`、`modes/`、`contracts/`：本地与登记共用的七模式、六组原生证据、备份回包核对。
- `identities.py`、`node_identity_reporter.cjs`：从实际输出采集身份和状态，保留重复次数。Node 同一次运行同时输出 TAP 和实际文件身份记录。
- `test_audit.py`：Python AST、Node/前端 TypeScript AST、QTest 槽和数据行审计；已签收用例的删除、改名、函数体改动必须有具体确认记录。
- `baseline.py`、`export_config.py`、`registration.py`：读取已签收基线、导出配置、冻结、逐次授权和执行。新格式基线也必须已有完整正式结果记录，不能用仅有的成功台账冒充签收。
- `measurement.py`：QTest 自身 XML 的整函数耗时。一个数据驱动函数包含其全部数据行，不把函数总时间伪称为每行时间。
- `coverage.py`：GUI 覆盖提示；不改变正式回归选择。

## 本地迭代

先核对 `.tools/local/<包>/authorization.json`。没有授权、授权撤销或超范围就拒绝；历史目录的旧 `registration.json.state` 不用于判断当前活动状态。

从已签收结果导出一份数据配置：

```sh
.venv/bin/python -I -B script/registered_run/cli.py export-config \
  --baseline .tools/reports/p1-worldbook-injection-r1-20261026 \
  --output .tools/local/<包>/config.json --include-tool-tests
```

配置中的 `stages[].baselineCommand` 是历史等价审计数据，不会直接执行。实际命令由 `stages.py` 构造。

```sh
.venv/bin/python -I -B script/registered_run/cli.py local \
  --package <包> --config .tools/local/<包>/config.json --category build

.venv/bin/python -I -B script/registered_run/cli.py local \
  --package <包> --config .tools/local/<包>/config.json --category full

.venv/bin/python -I -B script/registered_run/cli.py local \
  --package <包> --config .tools/local/<包>/config.json --category gui --select persona
```

类别为 `build`、`python`、`node`、`frontend`、`native`、`gui`、`replay`、`full`。`full` 是配置选择集的四类完整单测；构建须先显式执行。Python 可选择文件或 `文件::函数`；原生可选择目标、`目标::函数` 或 `目标::Class::函数(数据行)`。GUI 可选择多个模式，未选择时运行原七模式。

本地构建仅在 `.tools/qt-builds/local-<包>` 增量生成带 `localIteration` 标记的产物，不生成候选、不写任何指针。GUI、原生测量及 full 前，检查本地构建源码清单与当前工作源码相同；HEAD 未变但工作文件改变也必须重新构建。

运行器使用本次自有 data/tmp/cache/hf 目录，结束后只删除该目录。每次完成后向 `ledger.jsonl` 追加一行，失败日志保留。全局 `active-local.json` 在派发前建立；父进程崩溃、未知派发或清理未确认时保留，后续运行停止，不能靠删除锁文件或重跑绕过。仅限无运行的冻结登记可通过 `void` 作废；已消费或仍可能有进程的登记不能借此解除互斥。

新流水同时记录全量 `sourceTreeHash` 和排除 `docs/` 的 `codeTreeHash`。同代码范围、重叠检查失败后，普通重跑被拒绝，只改文档不会解除拒绝。`--diagnostic` 仅作诊断，之后的通过仍保留不稳定记录。运行中的边界继续核对 HEAD、全量文件和全量树，因此运行期间改文档也会中止。原因确已报告用户后可追加分析，不会修改失败行：

```sh
.venv/bin/python -I -B script/registered_run/cli.py analyze-local \
  --package <包> --sequence <失败序号> --reported-to-user --note '<原因和处理>'
```

`audit-tests --package <包> --config <配置>` 通过同一本地启动器只读比较工作树与签收源码；输出静态改动审计，不创建活动登记。`suggest-gui <改动路径...>` 只给覆盖提示。

## 测量

persona 整目标测量会准备原有六组全新证据导出目录，保留原写入断言，但不运行联合消费者、不声称完整原生合同通过。函数／数据行选择使用原测试支持的可选捕获关闭路径。真实备份消费需要完整配对批，不能将缺少回包的跳过计为通过。

```sh
.venv/bin/python -I -B script/registered_run/cli.py local \
  --package <包> --config <配置> --category native \
  --select persona-card-confirmation --qml-cache off
```

只在已核实当前 Qt 版本支持 `QML_DISK_CACHE_PATH` 时使用 `--qml-cache on` 对照；路径必须是本次隔离缓存的子目录。结果不推断缓存命中率，也不拆分未测到的 QML 编译、加载或等待成本。

## 登记运行

审阅完成后，用数据配置指定 `runKind`、阶段顺序、额度、时限、完整选择、GUI 顺序、新候选／CMake 目录和是否采用。`tool-validation` 与 `development` 不允许采用候选。

`freeze` 要求冻结时和所用记录均为干净源码，代码范围哈希相同；记录 HEAD 必须是冻结 HEAD 本身或祖先，二者间变动路径全部位于 `docs/`。同一干净 HEAD 的全量树也必须相同。`docs/` 之外的 Markdown、测试、脚本和 JSON 都属于代码范围。没有 `codeTreeHash` 的历史流水不能作为前置，不会补算或改写。

完整实际单测和所需 GUI 记录还须通过原始输出、宿主证明及测试改动审计；同一代码范围上的全部未分析失败都会阻止登记，不因 HEAD 或文档树不同而忽略。登记记录明确保存所用记录 HEAD 与中间文档路径清单。运行期冻结仍使用全量快照。

可先只读预演全部冻结核对，在本包下的新目录保存拟用材料；不会创建登记目录或活动标记：

```sh
.venv/bin/python -I -B script/registered_run/cli.py rehearse \
  --package PACKAGE --config CONFIG.json \
  --report .tools/reports/PROPOSED-ID \
  --output .tools/local/PACKAGE/REHEARSAL-NAME
```

预演给出 `contractSha256`，覆盖实际运行合同、身份清单、差异、测试改动审计结论、本地记录序号、代码哈希和历史清单，排除 HEAD、全量源码哈希与创建时间。登记文档可先引用它提交，再用 `freeze --contract-sha256 HASH` 冻结；哈希不符在任何登记发布前拒绝。真实测试变更的确认文档哈希和授权内容仍受绑定，不能借文档提交改掉审批条件。每次登记只保存数据、工具提交与哈希，不生成一次性运行器。

`authorize --report <目录> --user-approval-text '<用户明确原话>'` 只用于已经收到该次登记运行批准后记录原文。`run --report <目录>` 只消费一次授权；原始绑定、源码、完整历史、运行时配置在各边界复核，首败即停。SDK 后立即恢复原默认字节；只有正式种类完整通过且清理确认后才可采用捕获的新指针，采用后绑定失败会回滚。

正式结果的完整机器证据、状态和交接仍按流程规则第四节记录。完成这些记录后，该目录才能作为下一轮“上次正式签收”；本地记录永远不是验收证据。
