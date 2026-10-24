# Motion Photo Studio · 实况工坊

离线 Windows 桌面编辑器：导入本地视频、裁剪选段、选择独立封面，导出 JPEG + 内嵌 MP4 的单文件 Motion Photo。Electron / React / TypeScript，Rust Media Foundation/WASAPI 原生预览，FFmpeg 导入/导出与 Sharp 图像处理。

当前开发版本 **0.1.4**（本地完整包功能通过，真实性能/严格音画尚未全项验收，见[构建记录](docs/release-0.1.4.md)；先前交付的 0.1.3 ZIP 不含本次色彩修复）。支持“原画质（跟随原片）”一键高保真预设，跟随显示尺寸、帧时序、音频采样率和声道数；视频高保真转码，音频统一采用 **AAC-LC** 兼容编码，**不是数学无损**。不再在此预设下输出兼容性较差的 MP4 PCM 音轨。重新编码的视频实际转换为与 JPEG 封面一致的 sRGB 传递函数，减少封面切到播放时的发灰差异，详见[色彩一致性说明](docs/motion-photo-color-consistency.md)。仅有特定小米设备历史兼容证据，不承诺所有相册支持，新导出仍需目标设备实测。

## 构建

Windows、Node 24.11.0+：

```sh
cd app
npm ci --include=dev
npm run typecheck
npm run test:unit
```

完整构建需显式准备匹配的 FFmpeg/ffprobe，以及 Rust 1.99.1、MSVC/Windows SDK 和锁定的 Cargo 依赖（仅开发环境需要）。详见 [原生预览构建](native/preview-engine/README.md)。仓库不携带引擎二进制；应用不调用系统 PATH 兜底、不运行时下载。

```sh
node scripts/vendor-engine.ts --source-dir "你的引擎目录" --gpl-license "完整GPLv3许可文件"
npm run build:preview-engine
npm run build
npm run pack:win
```

GitHub 自动构建已配置：每次 main/PR 编译，每个版本标签触发 **Windows x64 免安装 ZIP** 流水线，通过媒体/打包测试后发布到 Releases（预发布）。完整解压后运行 `Motion Photo Studio.exe`，不需要安装。**目前仍需配置经过分发审核的引擎包，否则流水线明确报错，尚不能下载到完整免安装版。** 详见 [构建说明](docs/github-builds.md)。

## 原生编辑预览

普通 CFR AVC/HEVC MP4/MOV 导入优先读取容器候选索引，省去一次 FFprobe 全片视频扫描，但仍须完整原生逐帧核验；不满足条件时在准备期回退。VFR/复杂格式保留原路径，不承诺秒开。必要时一次性准备整片兼容资源；就绪后的播放、拖动、逐帧、缩略图和帧封面选择不再启动 FFmpeg/ffprobe。左右剪点和播放指针拖动均更新 Canvas；拖动会暂停播放，松手后保持暂停。导出仍按原片整数 PTS 重建所选封面。

历史 0.1.2 确切包的四份真实素材测量中，重复定位p95为20–51ms，短GOP1080p首轮p95为84ms；这些数据不是 0.1.3 的重新测量。长GOP/4K的未缓存定位仍可能较慢。真实HDR、硬解身份及物理音画延迟等尚未闭合，见[验收记录](docs/native-preview-acceptance.md)。Windows N 缺少 Media Foundation 时须先解决系统组件，不能用转码伪装原生后端已就绪。缓存清理仅处理可验证归属的目录；历史无标记数据不会被自动认领或删除，详见 [清理说明](docs/cache-cleanup.md)。

## 状态与隐私

AAC 音频修复已通过132项单元、13项相关集成及最终照片导出端到端验证，用户确认其原画质导出恢复声音。0.1.3 的完整重建/打包及 GitHub 自动编译结果记录在[版本验证](docs/release-0.1.3.md)。

历史确切包的功能验证不代表所有性能门槛达标：长 GOP 首次定位较慢，严格60个音画标记测试仍有历史失败。全项验收缺口见[验收记录](docs/native-preview-acceptance.md)与[执行记录](docs/native-preview-execution.md)。旧版本测试数量不能代替本轮验收或全设备认证。M5仍未完成：官方原文、第三方二进制许可/对应源代码、干净离线安装和更多目标手机复测待完善。

私人样本、包含本地素材路径的原始诊断、安装包及引擎二进制不纳入本仓库；去标识化的工程说明和验证记录保留在文档中。

源码当前未授予开源再分发许可证（package标为UNLICENSED）；公开可见不等于开源授权。第三方组件各自许可证独立适用。不要将本开发快照或未签名构建宣称为已验收正式版本。
