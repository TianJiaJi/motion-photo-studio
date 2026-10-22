# GitHub 自动构建：Windows 免安装版

用户选择的是 **完整免安装 ZIP**，不是 NSIS 安装器，也不是只含 JS 的源码编译包。

## 下载和运行

完成版本流水线后，在仓库 Releases 下载 `MotionPhotoStudio-X.Y.Z-win-x64-portable.zip`，完整解压到可写目录，双击 `Motion Photo Studio.exe`。不要只取出 EXE，也不要在压缩软件里直接运行。包含 Electron、原生 FFmpeg/ffprobe、Sharp 和所需资源，运行时不下载依赖。程序仍会在用户数据目录保存设置和缓存；“免安装”不意味着零写入或所有设置跟随U盘。

## 自动化

- main/PR：Windows + Node 24.11.0，锁文件安装、类型检查、单元测试、编译。`application-code-*` 仅供开发检查，**不能直接运行**。
- 版本：更新 package.json 与 lockfile 后推送 `vX.Y.Z` 标签，标签必须与版本一致。手动运行也可构建，但不自动创建 Release。
- 版本/手动构建：取得校验过的引擎、媒体集成测试、生成完整 portable ZIP、对确切打包EXE进行三项导出/保存测试、上传 ZIP 和 SHA256。
- 标签构建全部通过后创建 **预发布 Release** 并附上 ZIP 和校验文件。失败不发布，不覆盖已有 Release 附件。不宣称稳定版或全相册支持。

## 尚未解决：云端引擎供应

仓库不含本地引擎。现有 FFmpeg 全功能 GPL 构建及 Sharp/libvips 分发义务尚未完整复核，现成软件未直接公开上传。

Settings → Secrets and variables → Actions → Variables 需要：

- `ENGINE_BUNDLE_URL`：已审核可公开分发的 HTTPS ZIP。
- `ENGINE_BUNDLE_SHA256`：固定 SHA256，不采用未固定的 latest。

引擎ZIP根目录须含 `bin/ffmpeg.exe`、`bin/ffprobe.exe`、`engine-manifest.json` 和 `licenses/`；须提供完整许可、对应源码及构建说明，不能只给上游主页链接。引擎只在云端构建时下载，运行期完全离线。

**当前未配置这两个变量，版本免安装包仍会明确阻塞，不上传缺引擎的假成品。** 首次 main 云端源码检查通过不代表这个版本流水线已通过。更换引擎须重新进行完整媒体/打包/手机验收。

仅维护 Windows x64。M5官方原文、干净离线环境和目标相册复测尚未完成。
