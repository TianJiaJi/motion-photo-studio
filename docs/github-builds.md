# GitHub 自动构建

`main` 推送和 PR：Windows + Node 24.11.0，npm lockfile 安装、类型检查、单元测试、编译主进程/预加载/界面，产物位于 Actions 的 `application-code-*`。这不是可直接运行的安装包。

版本构建：更新 `app/package.json` 和 lockfile 中的版本，提交后推送对应 `vX.Y.Z` 标签（例如 `git tag v0.1.2 && git push origin v0.1.2`）。也可在 Actions 手动运行。标签必须与 package.json 一致。原生引擎就绪后自动运行媒体集成、生成未签名 Windows x64 NSIS 安装器和 SHA256SUMS，保存在该次 Actions 的 `windows-x64-*` artifact。不会自动宣称稳定版或手机兼容，也不自动覆盖 GitHub Release。

## 当前阻塞：原生引擎供应

源仓库不含本地 FFmpeg 二进制。现有 FFmpeg 全功能 GPL 构建及 Sharp/libvips 分发义务尚未完整复核，因此没有将本地引擎或现成安装器直接公开上传。源码公开不等于整个二进制分发许可已通过。

仓库 Settings → Secrets and variables → Actions → Variables 需要配置：

- `ENGINE_BUNDLE_URL`：已审核、可公开分发的 HTTPS ZIP。
- `ENGINE_BUNDLE_SHA256`：该 ZIP 的固定 SHA256，不可使用未固定内容的 latest。

ZIP 根目录必须含 `bin/ffmpeg.exe`、`bin/ffprobe.exe`、`engine-manifest.json`、`licenses/`。需要符合本项目 manifest 格式并覆盖所有必要许可、对应源代码及构建说明；不能只放一个上游主页链接。运行期不下载引擎；下载仅发生在云端构建。

未配置时，普通推送仍编译源码；版本/手动安装器任务明确失败，不上传缺引擎的假安装包。配置更换引擎会改变媒体处理行为，需要重新做媒体、打包桌面及手机验收。当前未声称云端首次构建已通过。

目前仅维护 Windows x64，不承诺 macOS/Linux/ARM 软件包。M5官方原文复核、干净离线安装和目标相册复测仍未完成。
