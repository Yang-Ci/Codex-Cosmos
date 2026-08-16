# Codex Cosmos

[![Build](https://github.com/Yang-Ci/Codex-Cosmos/actions/workflows/build.yml/badge.svg)](https://github.com/Yang-Ci/Codex-Cosmos/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/Yang-Ci/Codex-Cosmos)](https://github.com/Yang-Ci/Codex-Cosmos/releases)
[![License](https://img.shields.io/badge/license-MIT-77e8bc)](LICENSE)

Codex Cosmos 是一个跨平台桌面常驻组件：把本机 Codex 额度、时间、天气、每日一言与一组富有生命力的桌面工具收进一颗黑洞。

当前公开版本：**V1.0.2**。

## V1.0.2

- 拖拽回弹修复：拖动期间彻底暂停「边缘巡游」，松手后 8 秒宽限期，窗口稳定停在放置位置。
- 滑动条样式重做：深色轨道 + 绿色滑块，`color-scheme` 与 `accent-color` 兜底，避免 WebView2 下出现原生白条。
- 黑洞手势重排：双击左键打开额度面板、单击右键打开回收站、双击右键恢复上次回收。
- 新增「自定义用量 API」：支持自定义 REST 接口 + JSON Pointer 映射读取 token 用量，DSH 式环形 + 分段明细面板。
- 新增「余额查询」：DeepSeek 官方 / 中转站只需填写 API Key，自动读 `/user/balance` 余额；凭据存入系统凭据管理器。

## V1.0.1

- 显式声明方形 PNG bundle 图标，修复 Linux AppImage 封装失败；Windows 托盘继续显式继承应用图标。

## V1.0.0

- Codex 额度：读取本机 `~/.codex/sessions` 与 `~/.codex/archived_sessions` 的最新额度事件，展示剩余比例、官方周期、重置倒计时和 30 天本地估算。
- 日常信息：时间、日期、问候语、城市天气、体感温度、湿度、风速、降雨概率、7 天预测和离线每日一言。
- 三种尺寸：极简条、标准卡片与展开仪表盘；支持置顶、托盘、开机启动和低额度通知。
- 黑洞回收站：原生文件拖放、安全移入系统回收站、恢复最近一次回收、查看历史和双击打开回收站。
- 虫洞传送：将文件拖入虫洞，经过吸入与出口动画移动到独立配置的目标路径；同名文件自动避让。
- ZIP 星炉：投入 `.zip` 自动安全解压，投入其他文件或目录自动压缩为 ZIP；输出路径独立配置，原文件始终保留。
- 桌面生态：剪贴板彗星、专注月球、边缘巡游、天气视觉联动和随回收数量成长的黑洞。
- 崎岖桌面：原生、引力凹陷、月球坑、液态桌面、积雪、沙丘、太空尘埃七种可切换模式。
- GPU 效果：实时引力透镜、背景采样与局部扭曲、鼠标引力和粒子轨迹；提供节能、平衡、电影三档质量。
- 跨平台策略：Windows 使用桌面背景采样；Linux X11 使用内置星场与局部粒子；Wayland 自动降级受限的窗口定位能力。

## 获取与使用

从 [Releases](https://github.com/Yang-Ci/Codex-Cosmos/releases) 下载：

- Windows 安装包：`Codex Cosmos_*_x64-setup.exe`
- Windows 便携版：`CodexCosmos-Windows-x64-Portable.exe`
- Linux：AppImage 或 DEB

待机状态下将文件拖向不同区域：

- 中央黑洞：移入系统回收站
- 左下虫洞：移动到虫洞目标路径
- 右下星炉：ZIP 解压；其他文件或目录压缩为 ZIP

虫洞与星炉路径均可在设置中单独指定为绝对目录。

## 本地开发

需要 Node.js 22、pnpm 11、Rust stable 和 Tauri 2 所需系统依赖。

```bash
pnpm install --frozen-lockfile
pnpm tauri dev
```

验证：

```bash
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build
```

Linux 推荐 Ubuntu 22.04 或 Debian 12：

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf build-essential curl wget file libssl-dev
pnpm tauri build --bundles appimage,deb
```

完整架构、开发流程、兼容约束、测试清单和后续路线见 [中文开发交接文档](docs/DEVELOPMENT_HANDOFF.zh-CN.md)。

## 数据与隐私

- 只解析额度所需的 `token_count.rate_limits` 字段。
- 不读取 `~/.codex/auth.json`，不读取或展示会话正文。
- 不上传本地 Codex 数据；历史采样保存在操作系统应用数据目录。
- 天气只向 Open-Meteo 发送用户手动选择的经纬度，不使用 IP 定位。
- “30 天消耗”是明确标注的本地估算，不冒充官方月额度。

## 致谢与许可

黑洞渲染与安全回收语义借鉴并适配自 [Black Hole Trash](https://github.com/rrrjqy66/BlackHoleTrash)。完整第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

本项目使用 [MIT License](LICENSE)。
