# M0 本地验证记录

## 状态

**M0 最小格式闭环已完成，计划第 1 步已标记。当前设备为 Redmi K70E、OS 3.0.304.0.WNLCNXM.C11、Android 16、相册 4.3.1.18，USB 原文件传输。用户确认带标记可播放、自定义 C/D 保持封面、方向正常；选定 C 为该设备默认格式。最终产品的重开/音轨逐项回归仍待 M5，官方原文复核经用户明确同意后移 M5。**

## 已执行的检查

执行目录：`app/`。

| 命令/检查 | 结果 |
| --- | --- |
| `npm ci --include=dev --ignore-scripts` | 成功，开发依赖显式安装 |
| `npm run typecheck` | 通过；项目 strict 检查，第三方 `.d.ts` 使用 skipLibCheck |
| `npm run test:unit` | 最终 M0 回归 32/32 通过，0 跳过（含默认 profile 版本/标志验证） |
| `npm run test:integration` | 4/4 通过，0 跳过 |
| `npm run analyze:samples` | 12/12 通过，全部内嵌视频完整解码成功，所有源 SHA-256 前后相同 |
| `npm run fixtures:compat` | 36/36 新生成文件通过结构回读、JPEG/视频解码、嵌入视频哈希一致性校验；另有 1 张逐字节原生对照 |

对照包：`artifacts/m0/compat-20261021124310397-6e1757/`；生成任务 `be9b1be1d`，退出码 0。生成时清单状态为 `LOCAL_CHECKS_PASSED_AWAITING_PHONE`，`phoneStatus=NOT_TESTED`；清单保留生成时快照，后续真机反馈见同目录 `phone-feedback-01.md`、`phone-feedback-02.md` 和 `phone-results.csv`。第一轮只测 `phone-kit/` 根目录原生对照与 `00_native_video_frame0/` 内四张。

清单记录本次实际使用 FFmpeg 7.0.1 与 ffprobe 2026-05-21 构建，来自开发机 PATH，并非已审核配套的发行二进制；M1 仍需固定和审查版本，不把此运行环境直接打包发布。

初次完整检查任务：`b6182fe78`，退出码 0；最终默认 profile 回归：`b77cc52c9`，退出码 0（类型检查、32 单测、4 媒体集成）。样本结构/探测/哈希报告：`artifacts/m0/sample-analysis.json`。

本次未执行桌面构建、UI 测试、安装包、真实 4 GiB/2 小时压力测试或自动化真机相册测试；这些不能由本轮本地结果替代。用户手动相册识别反馈已另行记录。

## 覆盖的回归点

- 四组 profile 的 XMP 双写一致性，合法时间戳 0、未知时刻 -1、微秒时间值。
- 属性/元素两种 XML 写法、不同命名空间前缀、错误命名空间、DTD/重复字段/数值越界/损坏 XML。
- JPEG APP1 UTF-8 字节长度、超长段拒绝、metadata 内伪 EOI/ftyp、entropy stuffing/重启标记、跨块边界、多扫描结构。
- 正确 TIFF/ExifIFD 私有 BYTE 标志、不残留旧 XMP/MPF/私人注释。
- 源文件不变、目标不覆盖、取消、临时文件清理；拒绝直接覆盖源封面。
- 不把 EXIF 旋转标志悄悄改为 1：未归一方向的封面在 mux 层被拒绝。
- MP4 顶层 box walk 与大于 4 GiB 的 extended size（模拟读取，并非实际大文件压力测试）。
- 使用真实 FFmpeg 生成 H.264/AAC 和无声视频，四组文件独立提取后的 MP4 哈希等于输入视频，JPEG 与视频均可实际解码。
- 中文/空格路径、进程取消、缺失可执行程序、非 JPEG 假扩展名。

## 样本新增观察

12 张封面尺寸为 3472×4624 或 4624×3472，不等于视频编码尺寸 1080×1440；实现不得假定封面与视频像素尺寸相同。

`MVIMG_20261004_162631.jpg` 在主 JPEG EOI 与 MP4 起点之间存在 3 字节未归类间隙，而 XMP 的 Padding 为 0；视频长度/起点及解码均正确。分析器会报告这类间隙，生成器不复刻它，输出简单 JPEG + MP4 的零间隙结构。其他 11 张未发现间隙。

## 已解决的检查环境问题

1. 初次 npm 安装成功但未实际安装开发依赖，导致 `tsc` 不存在；改为显式 `npm ci --include=dev --ignore-scripts`。
2. saxes 6.0.0 自带声明有旧式泛型约束，与 TypeScript 5.9 不兼容；仅跳过第三方声明内部检查，不关闭项目 strict 类型检查，并用运行时解析测试覆盖关键路径。

## 后续发布验收（不伪报完成）

- 完整版本与方向已补齐，见 `phone-feedback-03.md`。
- M5 复测最终应用生成文件的逐项音频、重开/索引稳定性、长片与大文件。未把用户的“有些有声有些无声”扩写成逐文件音频验收通过。
- M5 取得并复核官方规范原文，尤其是未指定封面时间语义；当前网络抓取仍受限制，后移已得到用户明确同意。
