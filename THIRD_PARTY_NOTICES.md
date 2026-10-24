# 第三方组件与参考资料（M5 内部审查中）

本文件是开发阶段清单，不代表公开发行许可审查已完成。M0–M4 功能验收不替代许可审查。M1 已显式复制一套配套 FFmpeg/ffprobe 至本地 resources，以便离线打包测试；尚未批准公开分发。精确版本、文件哈希与内部使用限制见 `app/resources/engine-manifest.json` 和 `docs/offline-release.md`。

| 组件 | 使用方式 | 许可/来源 |
| --- | --- | --- |
| saxes 6.0.0 | XMP XML 解析运行时依赖 | package.json 声明 ISC，但已安装 npm 包未附完整许可文本；M5 须从上游取得原文，不以声明代替完整通知 |
| xmlchars 2.2.0 | saxes 间接运行时依赖 | MIT；`app/node_modules/xmlchars/LICENSE` |
| sharp 0.35.5 | 独立本地图像 worker 与原生预览静态 JPEG；ICC→sRGB、方向、裁切/留边、透明背景 | Apache-2.0；`app/node_modules/sharp/LICENSE`。固定 npm 依赖，运行时不下载 |
| @img/sharp-win32-x64 0.35.5 / libvips 8.18.7 / lcms 2.19.1 | sharp 的 Windows x64 原生图像/色彩处理组件 | 包声明 Apache-2.0 AND LGPL-3.0-or-later；实际附属组件版本见该包 `versions.json`。包内 LICENSE 仅见 Apache 文本，M5 须补齐 libvips/LGPL、依赖完整通知、对应源码/替换义务及原生二进制来源，尚不批准公开分发 |
| serde / serde_core / serde_derive 1.0.228、serde_json 1.0.145 | 原生 helper 控制协议 | MIT OR Apache-2.0；锁定 Cargo 版本，构建时保留原文 |
| windows 0.62.2 及 windows-* 依赖 | Windows MF/WASAPI/D3D API 绑定 | MIT OR Apache-2.0；完整版本和通知见生成的 `licenses/native-preview/DEPENDENCIES.json` |
| itoa 1.0.18、memchr 2.8.3、ryu 1.0.23 | Rust 序列化运行时依赖 | 分别为 MIT OR Apache-2.0、Unlicense OR MIT、Apache-2.0 OR BSL-1.0；保留实际包附带的许可原文 |
| proc-macro2 1.0.107、quote 1.0.47、syn 2.0.119、unicode-ident 1.0.27 | Rust 编译期宏依赖 | 前三项 MIT OR Apache-2.0；unicode-ident 为 (MIT OR Apache-2.0) AND Unicode-3.0，额外 Unicode 通知一并保留 |
| Rust 1.99.1 标准库/工具链通知 | helper 静态链接标准库；开发构建工具不随包安装 | 归档安装工具链中的 COPYRIGHT-library.html、COPYRIGHT.html 和 licenses/；通知集合包含不一定进入运行时的工具组件，不把整个集合当作应用许可声明 |
| TypeScript 5.9.3 | 开发类型检查 | Apache-2.0；包内 LICENSE.txt |
| @types/node 24.19.2 | 开发类型定义 | MIT；包内 LICENSE |
| React / React DOM 19.3.1、scheduler 0.28.0 | 本地 renderer UI / 实际随包 runtime | MIT；各包 LICENSE |
| @img/colour 1.1.0 | sharp runtime 色彩依赖 | MIT；实际归档 LICENSE.md |
| detect-libc 2.1.2 | sharp runtime 依赖（实际 Windows 包仍包含） | Apache-2.0；归档 LICENSE |
| semver 7.8.5 | 实际随包 runtime 依赖 | ISC；归档 LICENSE |
| Electron 45.0.0 | 内置桌面 runtime | MIT 及 Chromium/第三方许可；打包 runtime 原许可须保留 |
| FFmpeg / ffprobe 2026-05-21-git-0857141823 | 本地固定快照、独立进程调用 | 完整构建含 GPLv3 组件；已保存 -version/-buildconf/-L 与 GPLv3 文本，完整对应源码/附属许可未审核完，禁止公开分发 |
| electron-vite / Vite / electron-builder / Playwright | 开发构建与测试 | 精确版本在 package-lock.json；发行前复核实际随包组件许可 |

参考过用户提供的 `turn-video-into-live-photo-main`（根目录 `LISENSE` 为 MIT）的模块划分、XMP 样例与小米私有字段线索；当前容器模块为重新实现的有界解析/流式封装，不复制其硬编码厂商 EXIF blob、正则修补器或整文件 FileReader 逻辑。

`MotionPhotoMaker-main`（GPL-3.0）仅阅读说明作为行为参考，未复制其实现或打包其可执行文件；其纯 GPLv3 许可文本被原样复制用于本地工具许可资料，该文本自身允许原样复制，不等于复用该项目实现。FilmCraft 仅作为常驻调度、缓存和 Windows 后端的设计参考，未复制其源代码或界面资产；helper 为独立实现。未引入 Apple LivePhotosKit 或上传/统计功能。

原生预览构建固定 `x86_64-pc-windows-msvc` 和静态 CRT；不随包分发 Windows MF/WASAPI/D3D 系统 DLL，也不要求用户安装 Rust。`build:preview-engine` 从锁定 Cargo 包复制实际许可文本、Cargo.lock 和依赖清单至 `app/resources/licenses/native-preview/`，供打包保留。静态链接的 MSVC CRT 仍适用 Microsoft 工具链的再发行条款，不能由 Rust 的 MIT/Apache 通知推断其授权；分发前需一并核查。此新增清单不解除现有 FFmpeg、Sharp/libvips 或完整应用的公开分发审查限制。

M5 首个候选静态清单见 `artifacts/desktop/m4-internal-20261022091239843-edf86af6/candidate-evidence.json`：10 个实际 npm runtime 包及 9 个通知路径，Electron/Chromium 通知仍在，Sharp 原生文件哈希已记录。该清单仅是实际文件/声明盘点，不代表全文与对应源码审查通过。

发布前必须随发行物保留实际打包依赖的完整许可文本；对采用 libx264 的 FFmpeg 构建落实许可证和对应源码提供等义务，不将“通过独立进程调用”当作许可豁免。
