# Motion Photo Studio · 实况工坊

离线 Windows 桌面编辑器：导入本地视频、裁剪选段、选择独立封面，导出 JPEG + 内嵌 MP4 的单文件 Motion Photo。Electron / React / TypeScript，原生 FFmpeg / Sharp。

当前开发版本 **0.1.1**。支持“原画质（跟随原片）”一键高保真预设，跟随显示尺寸、帧时序和音频参数；允许转码，**不是数学无损**。PCM16路径保留选段样本。仅有特定小米设备历史兼容证据，不承诺所有相册支持，尤其 PCM 音轨仍需手机实测。

## 构建

Windows、Node 24.11.0+：

```sh
cd app
npm ci --include=dev
npm run typecheck
npm run test:unit
```

应用运行及完整构建需显式准备匹配的 FFmpeg/ffprobe。仓库不携带二进制、不调用系统 PATH 兜底、不运行时下载。

```sh
node scripts/vendor-engine.ts --source-dir "你的引擎目录" --gpl-license "完整GPLv3许可文件"
npm run build
npm run pack:win
```

GitHub 自动构建已配置：每次 main/PR 编译，每个版本标签触发安装器流水线。**安装器目前还需配置经过分发审核的引擎包，否则会明确报错，不产出缺引擎的假成品。** 详见 [构建说明](docs/github-builds.md)。

## 状态与隐私

本机历史检查：79单元、61媒体集成、8开发桌面及确切0.1.1打包程序3项导出/保存通过；不等于 GitHub CI 或全设备认证。M5仍未完成：官方原文、第三方二进制许可/对应源代码、干净离线安装、目标手机复测待完善。

私人样本、机器诊断、内部开发记录、安装包及引擎均未纳入本仓库。

源码当前未授予开源再分发许可证（package标为UNLICENSED）；公开可见不等于开源授权。第三方组件各自许可证独立适用。不要将本开发快照或未签名构建宣称为已验收正式版本。
