# Codex Cosmos V1.0 开发交接

这份文档面向接手项目的新电脑或新开发者。目标是先在 30 分钟内跑起来，再理解关键边界，最后安全地继续扩展。

## 1. 当前基线

- 产品名：Codex Cosmos
- 版本：1.0.0
- 仓库：`https://github.com/Yang-Ci/Codex-Cosmos`
- 技术栈：Tauri 2 + React 19 + TypeScript + Rust 2021 + WGSL
- 包管理器：pnpm 11
- 推荐 Node.js：22
- Rust：stable，Windows 目标为 MSVC
- 主要平台：Windows 10/11、Linux X11；Wayland 使用降级策略

V1.0 已具备额度、天气、每日一言、桌面组件三种尺寸、托盘、开机启动、黑洞回收、虫洞移动、ZIP 星炉、剪贴板彗星、专注月球、边缘巡游、七种桌面模式与 GPU 局部扭曲。

## 2. 先在新电脑跑起来

### Windows

安装 Git、Node.js 22、pnpm 11、Rust stable，并安装 Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”工作负载和 WebView2 Runtime。

```powershell
git clone https://github.com/Yang-Ci/Codex-Cosmos.git
cd Codex-Cosmos
corepack enable
pnpm install --frozen-lockfile
pnpm tauri dev
```

若 PowerShell 找不到 Rust，重开终端并确认：

```powershell
rustc --version
cargo --version
```

### Ubuntu 22.04 / Debian 12

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf build-essential curl wget file libssl-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
corepack enable
pnpm install --frozen-lockfile
pnpm tauri dev
```

## 3. 架构速览

```text
React / TypeScript
  App.tsx                 全局状态、窗口形态、拖放路由、设置与 UI
  BlackHoleCanvas.tsx     WebGPU/WGSL 渲染、背景采样、降级
  DesktopEcosystem.tsx    虫洞、星炉、彗星、月球等桌面生态层
  weather.ts / quotes.ts  外部天气与离线内容
           │ Tauri invoke / event
Rust
  lib.rs                  Tauri 启动、托盘、命令注册
  quota.rs                解析本机 Codex 额度与历史采样
  recycle.rs              系统回收、恢复、历史与路径校验
  ecosystem.rs            虫洞移动、ZIP 星炉、剪贴板、持久化
  desktop_capture.rs      Windows 桌面采样、显示器能力与平台降级
```

关键入口：

- `src/App.tsx`：绝大多数交互问题先从这里查。
- `src/styles.css`：组件尺寸、透明层、液态玻璃、动画和命中区域。
- `src/black_hole_trash.wgsl`：黑洞、透镜、天气和崎岖模式的 GPU 着色器。
- `src-tauri/src/lib.rs`：所有 Rust 命令必须在 `generate_handler!` 注册。
- `src/types.ts`：Rust 返回数据在前端的镜像类型。

## 4. 核心数据流

### Codex 额度

`quota.rs` 扫描 `~/.codex/sessions` 和 `~/.codex/archived_sessions`，只解析 `token_count.rate_limits`。前端每 30 秒调用 `get_pulse_data`。不要读取或上传会话正文，也不要读取 `auth.json`。

“30 天本地估算”不是官方月额度；任何新文案都必须继续明确这一点。

### 文件拖放

Tauri 提供系统原生文件路径，`App.tsx` 根据鼠标落点分发：

- `trash` → `recycle::move_to_trash`
- `wormhole` → `ecosystem::move_through_wormhole`
- `forge` → `ecosystem::forge_files`

拖拽时不要仅依赖 DOM `drop` 事件；Windows WebView2 的原生文件拖放由 Tauri 事件驱动。曾经出现“按住两秒内容展开”和拖动后双态叠加问题，相关锁在 `nativeFileDrag`、`manualWindowDrag`、`suppressWakeUntilLeave` 与延迟计时器附近。改动后必须做长按拖动和取消拖动回归测试。

### ZIP 星炉

- `.zip` 文件：解压到星炉目标目录下的同名文件夹。
- 其他文件或目录：生成同名 ZIP。
- 原输入永远保留；同名输出用 `(2)` 等后缀避让。
- 解压强制使用 `enclosed_name()`，拒绝符号链接，限制 10,000 个条目和 2 GiB 展开体积。
- 一批处理中任一项失败，会删除这批已经产生的输出，避免留下半成品。

不要为了支持更多格式而绕过上述安全边界。若以后加入 7z/tar，应先建立同等的路径穿越、符号链接、体积和原子性保护。

## 5. 数据与升级兼容：不要随意修改

`src-tauri/tauri.conf.json` 中的应用标识目前仍是：

```json
"identifier": "com.codexpulse.desktop"
```

这是有意保留的旧内部标识，不是漏改。Rust 的 `app_data_dir()` 依赖它定位：

- `quota-history.json`
- `recycle-history.json`
- `ecosystem.json`

直接改成 `com.codexcosmos.desktop` 会让升级用户看起来丢失额度历史、回收记录、虫洞和星炉路径。若未来一定要改，必须先做一次性迁移：新文件不存在时从旧目录复制，并在 Windows、Linux X11、Wayland 分别验证。

前端新键为 `codex-cosmos-settings/focus/weather`，但 `App.tsx` 会回退读取并迁移旧的 `codex-pulse-*` 键。至少保留两个正式版本周期。`quota-notice-*` 与品牌无关，不要改，否则会重复通知。

IPC 命令 `get_pulse_data`、类型 `PulseData`、目录 `.codex` 和 `CODEX_HOME` 是技术接口或 OpenAI Codex 术语，不属于旧品牌，不需要改名。

## 6. 常用开发命令

```bash
# Web 前端类型检查与生产构建
pnpm build

# 完整 Rust 测试
cargo test --manifest-path src-tauri/Cargo.toml

# 桌面开发模式
pnpm tauri dev

# 当前平台完整打包
pnpm tauri build

# Windows 只生成可直接运行的 release EXE，不打安装包
pnpm tauri build --no-bundle

# Linux 包
pnpm tauri build --bundles appimage,deb
```

第一次 `cargo` 构建会下载依赖，耗时明显更长。不要把 `node_modules/`、`dist/`、`src-tauri/target/`、测试截图、stage 目录或本地发布 EXE 提交到 Git。

## 7. 验证清单

每次功能改动至少执行：

1. `pnpm build`
2. `cargo test --manifest-path src-tauri/Cargo.toml`
3. 启动 release/便携版，确认 6 秒后仍存活且显示 WebView 窗口。
4. Windows 检查 PE Subsystem 为 GUI；release 构建由 `main.rs` 的 `windows_subsystem = "windows"` 保证不弹黑色终端框。
5. 待机与展开反复切换，不出现透明矩形或双态叠加。
6. 普通拖动窗口超过两秒，不自动展开内容。
7. 文件分别拖入中央、虫洞、星炉，并测试取消拖入。
8. ZIP 往返、同名输出、目录压缩和恶意 `../` 路径都应通过。
9. 切换七种模式、三档 GPU 质量、天气联动三档和鼠标引力开关。
10. 多显示器跨屏拖动；Windows 缩放 100%/125%/150% 至少抽测两档。
11. Linux 至少验证一个 X11 和一个 Wayland 会话；Wayland 降级不应影响额度、天气、回收与 ZIP 功能。

相关 Rust 单元测试位于 `quota.rs`、`recycle.rs` 和 `ecosystem.rs` 底部。新增文件系统行为必须带正常路径与拒绝路径测试。

## 8. 发布 V1.x

版本号需要同时修改：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `src/App.tsx` 设置页脚

然后执行全部验证，提交到 `main`，最后打标签：

```bash
git tag -a v1.0.1 -m "Codex Cosmos v1.0.1"
git push origin main
git push origin v1.0.1
```

`.github/workflows/build.yml` 会在 `v*` 标签上构建 Windows NSIS、Windows 便携版、Linux AppImage 和 DEB，并创建 GitHub Release。发布后检查两个矩阵任务和 Release 附件；任何平台失败都不要只重打标签，应修复后递增补丁版本。

## 9. 平台差异与排错

### Windows

- 背景采样和窗口捕获排除在 `desktop_capture.rs`。
- 透明窗口外框通常来自 Tauri 窗口尺寸与 CSS 根节点尺寸不一致，先核对 `sizeMap`、`idleSize` 和 `set_size` 调用。
- 便携版打开 localhost 拒绝连接，通常代表误交付开发壳或构建未嵌入最新 `dist`；必须用 `pnpm tauri build --no-bundle` 的 release EXE。
- 系统拒绝文件拖入时，检查应用和资源管理器是否处于不同权限级别；不要要求应用默认以管理员身份运行。

### Linux

- GNOME 托盘可能需要 AppIndicator 扩展。
- X11 可使用内置星场和局部粒子；当前没有 Windows 式桌面采样。
- Wayland 通常禁止应用任意设置绝对窗口位置，因此边缘巡游和跨屏定位会降级；不要把该限制视为崩溃。
- AppImage 尽量在较老的发行版基线上构建，提高 glibc 兼容范围。

### GPU

渲染器失败时先看 `effect_capabilities` 与 WebView 控制台，再检查 WGSL 编译。任何新效果都应有 CSS/Canvas 或关闭效果的可读降级，不允许因 WebGPU 不可用导致整张组件空白。

## 10. 后续优化路线

### 优先级 A：稳定性与发布质量

- 增加 React 交互测试，覆盖拖放目标判定、待机锁和设置迁移。
- 为 Windows 便携版、NSIS、AppImage、DEB 建立安装/卸载冒烟测试。
- 加入崩溃日志与可选诊断导出，默认不上传任何隐私数据。
- 正式代码签名，减少 Windows SmartScreen 警告。
- 完成真实多显示器、125%/150% 缩放和主副屏负坐标测试矩阵。

### 优先级 B：视觉与桌面生态

- GPU 透镜进一步采用自适应分辨率和帧率，静止时自动降到低功耗。
- 让液态桌面、积雪、沙丘与星尘对窗口/文件经过产生更连续的场响应。
- 虫洞加入可配置出口预设、最近目标与跨显示器传送动画。
- 星炉加入批处理进度、取消、压缩等级和完成后打开目录。
- 专注月球加入会话统计、勿扰模式和日历式连续记录。

### 优先级 C：外部 API 与扩展

- Provider 层：自定义 REST/JSON 地址、请求头、刷新周期和 JSONPath 映射。
- 凭据必须进入 Windows Credential Manager / Linux Secret Service，禁止明文写入配置。
- 支持文本、数值、进度、趋势与阈值告警卡片，并提供离线缓存。
- 天气可加入空气质量、灾害预警、日月相位，但需保持数据源可替换。

### 优先级 D：跨平台深化

- Linux 桌面背景采样：分别研究 X11 root pixmap 与 Wayland portal，可用时启用，不可用时继续星场降级。
- 多显示器按屏保存位置和视觉参数。
- macOS 可行性验证：透明置顶窗口、拖放、回收站、托盘与开机启动先做能力探测，再决定是否正式支持。

## 11. 接手后的第一周建议

1. 在 Windows release 和 Linux X11/Wayland 各完成一次验证清单。
2. 阅读 `App.tsx` 的拖放、展开与漂移 effect，画出状态转换后再改交互。
3. 跑完现有 Rust 测试，并亲手添加一个 ZIP 拒绝用例熟悉后端边界。
4. 从“星炉批处理进度/取消”或“React 拖放状态测试”选一个小功能完成第一个 PR。
5. 视觉功能每次只增加一个参数，并同时验证节能/平衡/电影三档和无 WebGPU 降级。

只要守住数据标识、文件系统安全、原生拖放状态锁和平台降级这四条边界，后续功能可以相对独立地演进。
