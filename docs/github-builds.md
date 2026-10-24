# GitHub 自动构建：Windows 免安装版

用户选择的是 **完整免安装 ZIP**，不是 NSIS 安装器，也不是只含 JS 的源码编译包。

## 下载和运行

完成版本流水线后，在仓库 Releases 下载 `MotionPhotoStudio-X.Y.Z-win-x64-portable.zip`，完整解压到可写目录，双击 `Motion Photo Studio.exe`。不要只取出 EXE，也不要在压缩软件里直接运行。包含 Electron、原生预览 helper、FFmpeg/ffprobe、Sharp 和所需资源，运行时不下载依赖。程序仍会在用户数据目录保存设置和缓存；“免安装”不意味着零写入或所有设置跟随U盘。

## 自动化

- main/PR：Windows + Node 24.11.0 + Rust 1.99.1，固定 MSVC x64 目标。先准备锁定依赖，再离线执行 Rust fmt/严格 Clippy/全目标测试（含诊断例子）/release 构建并归档许可；随后类型检查、应用单元测试、编译。`application-code-*` 仅供开发检查，**不能直接运行**。
- 版本：更新 package.json 与 lockfile 后推送 `vX.Y.Z` 标签，标签必须与版本一致。手动运行也可构建，但不自动创建 Release。
- 版本/手动构建：取得校验过的引擎、媒体集成测试、重建本仓库的预览 helper（不信任 FFmpeg 压缩包中可能同名的文件）、生成完整 portable ZIP、对确切打包EXE进行预览/清理/异常恢复及导出/保存测试、上传 ZIP 和 SHA256。
- 标签构建全部通过后创建 **预发布 Release** 并附上 ZIP 和校验文件。失败不发布，不覆盖已有 Release 附件。不宣称稳定版或全相册支持。

## 尚未解决：云端引擎供应

仓库不含本地引擎。现有 FFmpeg 全功能 GPL 构建及 Sharp/libvips 分发义务尚未完整复核，现成软件未直接公开上传。

Settings → Secrets and variables → Actions → Variables 需要：

- `ENGINE_BUNDLE_URL`：已审核可公开分发的 HTTPS ZIP。
- `ENGINE_BUNDLE_SHA256`：固定 SHA256，不采用未固定的 latest。

引擎ZIP根目录须含 `bin/ffmpeg.exe`、`bin/ffprobe.exe`、`engine-manifest.json` 和 `licenses/`；须提供完整许可、对应源码及构建说明，不能只给上游主页链接。引擎只在云端构建时下载，运行期完全离线。

**当前未配置这两个变量，版本免安装包仍会明确阻塞，不上传缺引擎的假成品。** 首次 main 云端源码检查通过不代表这个版本流水线已通过。更换引擎须重新进行完整媒体/打包/手机验收。

## 工件与失败证据

工件名使用 `run_id` 与提交 SHA，不直接使用可能包含 `/` 的 PR/分支名称。完整包桌面测试显式排除仅开发构建使用的 `missing engine package` 夹具，并另用隔离副本验证 helper 缺失、篡改、版本和 MF 失败；不会修改待交付包。失败时上传 Playwright 结果供排查，不把跳过的夹具记作通过。

## 原生预览资源

开发机先安装固定 Rust/MSVC/SDK 并准备 Cargo.lock 中的依赖，然后在 `app/` 执行 `npm run build:preview-engine`。脚本使用离线 Cargo 构建，生成 `resources/bin/motion-preview.exe`、独立的 `native-preview-manifest.json` 及许可目录。`npm run build` 会分别校验 FFmpeg 与预览引擎；开发运行也不从 PATH 或旧 prototype 路径补找 helper。`pack:win` 与 `dist:win:internal` 会先构建原生资源，在唯一的 `artifacts/desktop/native-internal-*` 目录输出，随后核对打包后的清单、helper、Cargo锁和完整许可树，并实际执行资源握手/版本检查。成功记录为 `RESOURCE-VERIFICATION.json`，失败保留 `BUILD-FAILURE.json` 与部分输出，不拿旧包补位。这个资源检查不替代确切打包应用的桌面测试或 ZIP 解压后的干净环境验收。

运行时验证清单版本、文件尺寸/SHA256、PE x64 架构及协议握手，每个新素材会话前复核文件。清单是包内一致性校验，不是数字签名或针对能同时改写程序与清单的本机攻击者的认证。用户无需安装 Rust、FFmpeg 或开发工具；Windows N 缺少 Media Foundation 时必须先解决系统组件，转码不能替代它。

完整媒体/音频验收需要可用的 MF 和 WASAPI 音频端点；若托管 Windows runner 缺少这些环境条件，应报告失败并安排具备条件的 Windows 验证，不把跳过音频或只上传 JS 当作通过。新增 CI 配置尚不等于已经在云端成功执行；0.1.3 的实际提交/run 结果见[本轮验证记录](release-0.1.3.md)。

仅维护 Windows x64。M5官方原文、干净离线环境和目标相册复测尚未完成。
