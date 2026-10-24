# 离线内部构建与发布门槛（M5 验收中）

## 当前范围与证据

M0–M4 已完成：本地视频导入、原文件/代理预览、时间轴/画面裁剪、原画/普通双路径、封面、最终单 JPG 保存与恢复治理。M4 基线见 `docs/m4-implementation-notes.md`；M5 进度及阻塞见 `docs/m5-verification.md`。

用户运行不需要 Node、系统 FFmpeg 或运行时下载。开发依赖安装及首次构建工具下载可能联网，与运行时离线要求不同。当前全部产物仍是**本机内部验证，不可公开分发**。

## 安全边界

- renderer 禁用 Node/webview，启用 sandbox/contextIsolation；固定 typed preload，不暴露 ipcRenderer、通用 invoke、任意命令或路径处理接口。
- IPC 校验窗口、主 frame、应用 URL 与严格参数结构。保存只接受素材/草稿/请求 UUID；输出路径由主进程原生保存对话框取得。
- `app://ui/` 读取内置资源，固定根目录、防路径穿越、CSP；媒体使用不可猜测的受控本地流 URL，支持范围读取/撤销/源变化检查。拒绝导航、弹窗、权限、下载和外部 renderer 网络请求。
- 原生工具使用参数数组、shell:false。固定路径/版本/哈希，不回退 PATH、不运行时下载。退出时等待任务和缓存清理；独立图像 worker 监听父 IPC 断连终止。
- 目标侧私有工作区流式 mux，回读 JPEG/MP4 字节与元数据后用同卷硬链接无覆盖提交。文件系统不支持则明确失败；不回退覆盖。已提交成品不列入恢复清理记录。

## 引擎准备

```cmd
cd app
node scripts/vendor-engine.ts --source-dir "C:\ffmpeg-2026-05-21-git-0857141823-full_build\bin" --gpl-license "..\样本\参考代码\MotionPhotoMaker-main\LICENSE"
```

仅检查并复制配套 x64 PE，存在且哈希不同则拒绝覆盖，生成精确 SHA-256/字节数/构建号清单，保留 -version/-buildconf/-L 与 GPLv3 文本。复制许可文本不等于复用 GPL 参考实现，也不表示完整对应源码与依赖义务已履行；本机快照并非已核验厂商签名的公开发行构建。

## 内部构建

```cmd
cd app
npm ci --include=dev
npm run typecheck
npm run test:unit
set "FFMPEG_PATH=%CD%\resources\bin\ffmpeg.exe"
set "FFPROBE_PATH=%CD%\resources\bin\ffprobe.exe"
npm run test:integration
npm run build
npm run test:desktop
npm run pack:win
```

`pack:win` 只生成 unpacked EXE 目录；`dist:win:internal` 生成 NSIS。每次输出到独立 `artifacts/desktop/m4-internal-时间-UUID/`，名称为 `MotionPhotoStudio-M4-dev-<version>-win-x64-setup.exe`（生成 NSIS 时）。M4 是功能基线标签，不代表 M5 发布验收已完成。--publish never；未经许可/验收不得对外分发。

明确保留 M1 回滚包 `artifacts/desktop/MotionPhotoStudio-M1-0.1.0-win-x64-setup.exe`。新命令不写其目录同名文件，不把旧 M1 EXE 用于当前 bridge 测试。Sharp Windows 原生组件显式 asarUnpack；配置成功不等于 DLL/asar/IPC 实际运行成功。

首次安装 Electron 开发依赖需其官方安装脚本；不能全局 --ignore-scripts。受限环境应预先提供可信构建缓存，不改成运行时联网补组件。

## 验证层级不可混写

1. **源码/开发 Electron**：类型、单元、媒体/完全解码、编辑/保存、安全、缺引擎失败与取消。
2. **新 packaged EXE**：指定本次唯一候选，测试环境 PATH 移除 Node/FFmpeg、renderer 离线，执行真实编辑/复制与普通最终保存，覆盖 Sharp/asar/DLL/父 IPC。它仍不是干净 Windows。
3. **NSIS 生成**：产物存在/哈希/大小/签名状态；不等于已安装。
4. **干净离线 Windows 安装/运行/卸载**：无开发依赖；不得用开发机改 PATH 替代。安装范围当前用户，保留数据，不自动运行，未签名状态如实提示。
5. **真实大/长媒体与目标手机**：真实 >4 GiB 输入及输出、至少两小时输入、资源/取消观察；指定系统/相册版本原文件 USB 复测。桌面播放或元数据齐全不是手机证据。

压力脚本 `node scripts/m5-resource-check.ts` 使用系统临时盘独立目录，需 26 GiB 空间含安全余量，不故意填满磁盘。其预算/样本参数是测试条件，不是产品大小/时长上限。详细输出与限制记录在 M5 文档。

## 公开发布前置条件

- 官方 Motion Photo/厂商规范原文复核仍 mandatory；本轮 fake-IP 安全检查阻止原始三份正文，未规避。
- 审查全部实际打包许可/来源；FFmpeg 含 GPL 组件，落实精确对应源码和依赖许可，独立进程不是豁免。Sharp/libvips/LGPL 原文/源码/替换义务和 saxes 原文仍未闭合，见 `THIRD_PARTY_NOTICES.md`。
- 保留 Electron/Chromium 原始全部许可。不打包用户私人样本或测试原片。
- 未购签名证书，不称已签名，不绕过 SmartScreen/系统安全策略。
- 提交兼容矩阵、实际限制和用户操作说明；仅标注实测设备/系统/相册组合，不承诺全部小米或无限性能。
