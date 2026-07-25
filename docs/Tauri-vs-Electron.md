# Tauri 2.x vs Electron — Reverie 桌面壳选型评估

> 基于 Risuai (GPL-3.0) 的 Tauri 配置分析
> 评估日期：2026-07-04

---

## 对比矩阵

| 维度 | Electron (当前) | Tauri 2.x (Risuai 方案) | 结论 |
|------|----------------|------------------------|------|
| **包体积** | ~150MB (含 Chromium) | ~5-10MB (系统 WebView) | Tauri 胜 |
| **内存占用** | ~200-400MB | ~50-100MB | Tauri 胜 |
| **后端语言** | Node.js (JS) | Rust | 持平 |
| **前端框架** | 任意 (React/Vue/Svelte) | 任意 (系统 WebView) | 持平 |
| **Python 集成** | child_process.spawn | Rust Command::new | 持平 |
| **插件生态** | 丰富 (npm) | 快速增长 | Electron 略胜 |
| **自动更新** | electron-updater | tauri-plugin-updater 2.9.0 | Risuai 已实现 |
| **单实例锁** | app.requestSingleInstanceLock | tauri-plugin-single-instance | 均有支持 |
| **深度链接** | protocol.register | tauri-plugin-deep-link | 均有支持 |
| **文件系统** | Node.js fs | tauri-plugin-fs 2.4.5 | 均有支持 |
| **HTTP 请求** | Node.js http/fetch | tauri-plugin-http 2.5.5 | 均有支持 |
| **Shell 命令** | child_process | tauri-plugin-shell 2.3.3 | 均有支持 |
| **对话框** | dialog API | tauri-plugin-dialog 2.5.0 | 均有支持 |
| **开发体验** | pnpm + Vite (已配置) | Rust toolchain + pnpm | Electron 已就绪 |
| **Windows 支持** | 优秀 | 优秀 (WebView2 内置于 Win10+) | 持平 |

---

## Tauri 优势

1. **包体积**：不捆绑 Chromium，安装包从 ~150MB → ~5-10MB
2. **内存**：系统 WebView 共享内存，比独立 Chromium 节省 100-200MB
3. **性能**：Rust 后端比 Node.js 更快（但 Reverie 主要负载在 Python，影响有限）
4. **安全性**：Rust 内存安全保证

## Electron 优势

1. **已就绪**：前端已配置完成（pnpm + Vite + React），Electron 二进制已下载
2. **生态成熟**：npm 生态更丰富，遇到问题更容易搜索解决方案
3. **DevTools**：Chromium DevTools 调试体验优秀
4. **一致性**：所有平台使用完全相同的 Chromium 版本，无 WebView 差异

---

## Risuai 的 Tauri 配置参考

```toml
# Cargo.toml 关键依赖
tauri = { version = "2.9.5", features = ["protocol-asset", "devtools"] }
tauri-plugin-fs = "2.4.5"       # 文件系统访问
tauri-plugin-dialog = "2.5.0"   # 文件对话框
tauri-plugin-shell = "2.3.3"    # 启动外部进程 (Python)
tauri-plugin-http = "2.5.5"     # HTTP 请求
tauri-plugin-updater = "2.9.0"  # 自动更新
tauri-plugin-single-instance = "2.2.3"  # 单实例
tiktoken-rs = "0.4.0"           # Token 计数 (Rust 实现)
```

---

## 推荐

**短期（当前阶段）：保持 Electron。**
- 前端已完整配置，切换成本高（需安装 Rust toolchain、重写 main.js → Rust）
- Electron 功能完整，DevTools 调试方便
- 包体积问题可在打包阶段通过 asar 压缩缓解

**中期（V1.0 后）：迁移至 Tauri 2.x。**
- 减小安装包体积（对 Windows 用户友好）
- 降低运行时内存占用
- 借鉴 Risuai 的 Cargo.toml 和 tauri.conf.json 配置
- 迁移时保留现有前端代码（React/Vite 无需修改，Tauri 同样加载 dist/ 目录）

**迁移工作量估算**：
- src-tauri/ 目录创建 + Cargo.toml 配置：2-4 小时
- main.rs 实现（窗口管理 + Python 子进程 + IPC）：4-8 小时
- 测试与调试：4-8 小时
- 总计：约 2-3 个工作日
