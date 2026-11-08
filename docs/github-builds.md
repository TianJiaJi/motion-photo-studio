# GitHub 自动构建与版本发行

交付物是 **Windows x64 完整免安装 ZIP**，不是安装器，也不是仅包含 JavaScript 的 application-code 工件。完整解压后运行 `Motion Photo Studio.exe`，运行期不联网下载引擎。

## 发行规则

1. 修改 `app/package.json` 版本，并同步 `app/package-lock.json` 根版本及 packages 根条目。
2. 新增 `docs/releases/vX.Y.Z.md`，第一行必须为 `# Motion Photo Studio vX.Y.Z`，正文写明更新、下载方法和限制。
3. 推送 main。流水线比较 **这次 push 之前的提交** 与当前版本（支持一次 push 多个提交）。版本增加才触发完整构建和发布；普通代码提交/PR 只跑源码验证。
4. 通过全部门槛后，按实际构建 SHA 创建同名标签，不移动已有标签，创建预发布 Release。`--notes-file` 将对应版本的详细说明写入 Release 正文，不使用固定的一句通用描述。
5. 若未发布版本首次构建失败，可修复后手动运行 workflow_dispatch，并明确选择 publish=true 重试；默认手动构建不发布。已经发布的版本应递增，不覆盖旧附件。

标签触发也保留，但标签必须等于应用版本。版本倒退、锁文件不同步、缺少详细说明会阻止发行。

## 完整引擎与源码链路

旧流程依赖尚未配置的 ENGINE_BUNDLE_URL/SHA256，开发机 FFmpeg 又是内部快照，不能把它直接改标记上传。本轮改为独立 Linux 源码构建任务：

- `app/release/sources.json` 固定 FFmpeg、x264、x265、zimg、zlib 源码提交。Git fetch 后检查实际 HEAD，再生成对应源码快照。
- Linux 交叉编译 Windows 静态 FFmpeg/ffprobe，启用 GPLv3、x264、8/10-bit x265、zscale 和 zlib，不启用 nonfree、网络或自动探测的额外第三方库；检查没有遗漏的第三方运行 DLL。
- 固定 Sharp/Sharp-libvips/libvips Windows 构建配方及 MXE 提交；按锁定 Windows npm 包的 versions.json 核对每个组件版本，使用上游配方校验并下载对应源码、保留全部补丁与构建资料，额外归档 librsvg 的锁定 Rust 依赖。
- Windows npm libvips DLL 必须与固定 SHA256 的上游 SDK 完全匹配；记录 npm integrity、DLL SHA256 和源码版本，不能仅放几个主页链接。
- `engine-artifact.mjs` 封存源码提交、源码附件与引擎哈希；Windows 构建只接受同一工作流 SHA/固定组件集合的产物，再生成独立媒体引擎清单。Rust helper 仍从本仓库锁定源码构建，不接受外来 helper 替换。

来源记录与源码资料不是法律认证、专利授权、可信签名或跨编译器的逐字节可复现承诺。引擎更换必须重新经过媒体/确切包测试。新脚本已编写不等于云端已经成功；以具体 run 和附件核验为准。

## Windows 验证与发布

- Node 24.11.0；Rust 1.99.1/MSVC x64。Rust fmt、严格 Clippy、全目标测试、release 构建和许可证清单。
- 类型检查、应用单元、源码编译；普通 main/PR 在此结束，application-code 工件不能独立运行。
- 完整发行继续执行引擎/源码摘要检查、完整媒体集成测试、生成 portable ZIP、对实际打包 EXE 执行桌面测试（包含片段工具、自定义时长、导出即时预览等）及隔离原生故障测试。
- 开发专用缺引擎夹具明确排除；缺大文件素材的压力测试不计通过。若云端缺 MF/真实 WASAPI 端点，必须报告失败，不能静音、放宽或跳过既定音频门槛冒充通过。
- 仅全部成功后上传并发布 ZIP、第三方源码 tar.gz、ENGINE-BUILD-MANIFEST.json、SHA256SUMS.txt；发布前再检查全部附件摘要。
- 失败保留来源构建或 Playwright 证据，不用旧包补位，不覆盖已有发行附件。

## 使用与限制

在 Releases 下载 `MotionPhotoStudio-X.Y.Z-win-x64-portable.zip`，完整解压到可写目录。不要仅取 EXE。程序会写应用用户数据/私有缓存；免安装不等于零写入或U盘项目持久化。

运行包包含许可证与替换说明，第三方源码在同版本附件。FFmpeg 可重建后同时更新一致性清单，LGPL 图像库 DLL 保持可替换；不以应用版权声明限制第三方许可授予的权利。

未签名预览，Windows N 缺 Media Foundation 须先处理系统组件。干净离线实机、物理音画、代表性冷/热性能、多手机相册和大型压力验收仍不是本流水线源码/功能通过所能证明的。
