# Android Motion Photo — 离线桌面工具

M0–M4 已完成，当前进入 **M5 回归与发布前验收**。开发版已支持导入、预览、时间轴双手柄选段、画面裁剪、封面和参数；最新 0.1.1 将原“无损”开关按用户澄清改为“原画质（跟随原片）”一键预设：跟随原尺寸/帧时序和音频参数，允许高保真编码（非严格无损），PCM16保留真实样本，关闭恢复编辑设置，“预览输出”实际生成并校验私有视频/JPEG 草稿。当前 M4 源码已接入“导出实况”→确认输出→原生保存位置，只有显示“已保存”才表示完成最终文件发布；**仅生成预览不会自动保存**。M4 本地验收已通过（78 单元、59 媒体、7 开发桌面）；尚未完成新版本安装/真机/大文件与发布验收。自检和引擎信息收进“帮助与检查”，主界面只保留编辑核心功能。M0 命令行工具继续保留作回归与对照。

最新预设回归/交付边界见 `docs/m5-original-first-audio-policy.md`，新包尚未跑完门禁前不要用旧安装包声称包含此功能。其他进度见项目根目录 `docs/m4-implementation-notes.md`、`docs/m5-verification.md`、`docs/ui-workspace-revision.md`。多音轨必须明确选轨或取消保留，不默认丢弃其他轨；最新 78 项单元、59 项媒体及 7 项开发桌面回归通过。新版本的打包运行、大/长媒体、干净安装和手机验收分别记录，不相互替代。

## 桌面基础开发

```cmd
cd app
npm ci --include=dev
set "FFMPEG_PATH=%CD%\resources\bin\ffmpeg.exe"
set "FFPROBE_PATH=%CD%\resources\bin\ffprobe.exe"
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
npm run test:desktop
```

构建需先按 `docs/offline-release.md`（位于项目根目录）准备配套引擎。开发可用 `npm run dev`，已构建应用可用 `npm start`。首次 Electron 开发安装需要其官方安装脚本，因此桌面环境不能全局禁用安装脚本；原 M0 纯 Node 测试命令见下方。

桌面通过 sandbox + contextIsolation 的最小 preload 接口通信；生产渲染器只能读取本地资源，媒体进程不使用 shell。引擎缺失/哈希错误时明确失败，绝不回退 PATH 或联网下载。

M1 内部安装产物保留在 `artifacts/desktop/`，不是当前 M4 功能版，也不是已完成许可证/签名/最终产品验收的公开发行版。当前 `npm run pack:win` / `npm run dist:win:internal` 会生成独立的 `m4-internal-时间-UUID` 目录和 M4-dev 名称，不覆盖 M1 回滚包；M5 正在实际运行新打包与 packaged runtime 验证，未完成前不宣称通过。

封面采用固定 sharp/libvips/lcms 本地图像组件，单独 worker 处理真实 ICC→sRGB、方向、裁切/留边和透明背景，不通过运行时下载补组件。媒体集成测试限制两个文件并行；这是测试进程资源约束，不是产品视频时长限制。新增原生组件的打包、完整第三方通知及源码义务审查仍待 M5。

## M0 命令行环境

- Node.js >= 24.11（直接运行可擦除 TypeScript 类型，无构建产物）。
- 开发机已有 FFmpeg / ffprobe，可用 `FFMPEG_PATH` / `FFPROBE_PATH` 指定可执行文件路径。
- Windows 命令提示符中：

```cmd
cd app
npm ci --include=dev --ignore-scripts
npm run typecheck
npm run test:unit
npm run test:integration
npm run analyze:samples
npm run fixtures:compat
```

显式使用 `--include=dev`，避免执行环境的 production/omit 设置跳过 TypeScript 与类型定义。首次安装开发依赖可能需要联网。**未来发布给用户的应用完全离线**；当前开发依赖安装不等于应用运行时联网。

## 命令

| 命令 | 行为 |
| --- | --- |
| `npm run analyze:samples` | 只读扫描 `../样本/小米手机实况/`，检查结构、EXIF、MP4 全解码和源文件前后 SHA-256；输出 `../artifacts/m0/sample-analysis.json` |
| `npm run analyze:samples -- --output ../artifacts/m0/analysis-2.json` | 指定新的报告路径；默认拒绝覆盖已有报告 |
| `npm run fixtures:compat` | 生成唯一运行目录、四组 profile × 九种场景、原生阳性对照、哈希清单与手机结果表 |
| `npm run validate:motion -- --strict "path/to/generated.jpg"` | 检查生成文件并独立提取/完整解码其 MP4；不代表手机识别通过 |

`fixtures:compat` 第一轮只需测试 **5 张**：原生对照 + `00_native_video_frame0` 的四组。后续 01–08 覆盖横竖屏、音轨、抽帧/自定义封面。手机仅需接收 `phone-kit/` 内容，电脑生成的 `work/` 不需要传输。

脚本只向新建的 `artifacts/` 或调用方指定的输出目录写入，不修改样本。所有导出目标不覆盖已有文件。原生对照/00 组包含用户提供的私人素材，请勿公开上传；其余场景是程序生成的测试动画。

## 实现边界

- `motion/jpeg.ts`：按 marker/segment/entropy stuffing 解析 JPEG，支持常见多扫描图片；保留 JFIF/Adobe/ICC，删除旧 EXIF/XMP/MPF/厂商数据与注释。
- `motion/xmp.ts`：使用 saxes 按命名空间读取属性/元素形式，拒绝 DTD、重复字段、数值越界及新旧字段冲突。saxes 6 的声明文件有与 TypeScript 5.9 不兼容的泛型约束，设置 `skipLibCheck` 跳过第三方 `.d.ts` 内部检查；项目自身仍使用 strict 类型检查，解析行为有运行时测试。
- `motion/mp4.ts`：按顶层 box 长度定位，支持 64-bit extended size，不把搜索 `ftyp` 字节当作解析。
- `motion/mux.ts`：有界拷贝、源文件变更检查、临时文件回读验证、同卷硬链接无覆盖发布。输出文件系统需支持硬链接；不支持会明确失败，不退回不安全覆盖。
- 当前实测设备默认 profile 为 **C-modern-xiaomi**：Redmi K70E / OS 3.0.304.0.WNLCNXM.C11 / Android 16 / 相册 4.3.1.18；仅有该组合的用户真机反馈，不代表全部小米系统。A/B/D 保留为对照候选。`0x8897` 是样本观察及兼容对照支持的私有标志，不是已确认的官方必要条件。
- 当前仅支持普通 JPEG 主图 + 一个尾部 MP4，生成无 padding 的简单容器；多资源/HDR 增益图不在 PoC 输出范围。
- `muxMotion` 是容器层：调用方必须传入已归一方向/SDR 的 JPEG 和已处理的兼容 MP4；不承担裁剪、转码、色调映射，也不凭 box 检查保证完整视频可解码。脚本另外执行真实媒体解码校验。
- 原生样本中 JPEG EOI 到视频之间如有附加数据会报告，不直接复制到新封面。
- `-1` 用于自定义封面无对应视频时刻；用户已确认当前设备上 C/D 的封面保持和播放切换正常。官方原文语义复核经用户同意后移发布前，不能把当前实测当作跨设备规范保证。
- Node 偏移使用安全整数（不做 32 位截断），单测覆盖超过 4 GiB 的 box；M5 已另通过实际 4.565 GB 输入/输出和两小时合成媒体的后端链路，证据及其低分辨率/父 Node RSS 范围见 `docs/m5-verification.md`，不等于 GUI/手机/全系统压力均通过。

M1 使用显式选定并固定哈希/版本的配套引擎，详情见 `resources/engine-manifest.json`；不是运行时自动使用 PATH。完整对应源码/第三方许可审查与最终公开发行仍是 M5 门槛。
