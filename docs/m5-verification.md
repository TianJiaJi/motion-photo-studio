# M5 回归与发布前验收（进行中，未批准公开发布）

**用户现场反馈后的修正：** 导出分析不支持时的静默返回分支已修正，#19 通过 8 项开发桌面和新候选 3 项 packaged 导出/保存测试，确切新 EXE 已打开给用户。新候选为 `m4-internal-20261022105109198-500e4576`；见 `docs/m5-export-feedback-fix.md`。用户实际输入的拒绝原因/最终导出结果仍待新提示反馈；以下旧候选/NSIS证据是历史基线，不含修正，不能拿旧安装包冒充新版或宣称产品已无问题。

**后续需求 #20 已完成本机交付：** 按用户最终定义改为一键“原画质（跟随原片）”，允许高保真转码；79单元、61完整媒体、8开发桌面及确切0.1.1新包3项导出/保存通过。新候选 `m4-internal-20261022123933540-d2abc68a` 已打开给用户，旧窗口未关闭。见 `docs/m5-original-first-audio-policy.md`。实际用户导出/手机表现及M5其他门槛未通过，旧0.1.0安装包不包含预设，不能冒充新版。

M4 已在计划第 5 步标记完成后才进入本阶段。基线 `be4562e13`：78 单元、59 媒体、构建、7 开发 Electron 桌面全部通过；类型检查另行通过。各阶段证据不相互替代。

## 运行中的本地验证

- `bc68eb6f0` 退出 0：`npm run pack:win` 生成独立 `artifacts/desktop/m4-internal-20261022091239843-edf86af6/win-unpacked/`。仅 unpacked，不是 NSIS。构建日志有 Electron zip 下载/解包，这是开发打包联网，不等于用户 runtime 下载。运行门禁 `bd768ec8e` **退出 0，6 项通过、1 项明确跳过**：确切新 EXE（不是 M1），隔离 userData、System32-only PATH、renderer 离线，真实编辑/两模式保存/Sharp/asar/DLL/父 IPC 通过；缺引擎开发 fixture 跳过（开发轮已通过）。仍不是干净 Windows 或物理全机断网。
- `b00ebd844` **退出 0**：`node scripts/m5-resource-check.ts`。真实编码的合成媒体，不用 sparse 文件、MP4 free-box 凑体积或只延长 metadata。先以两秒 CBR AVC 校准实际字节量，再生成 >4 GiB 输入与实际最终 JPG、至少 7200 秒/72000 帧长输入/输出。走正式原画校验、封面、容器发布、独立提取/全解码/完整哈希、完整 mux 后提交前取消及清理。
- D 盘检查时约 5.09 GB 可用，不适合承载多份 >4 GiB 样本；压力数据改在系统临时盘的独立 `Motion Photo M5-随机` 目录。脚本开始必须有 26 GiB 空间（峰值约四份大文件，含至少 8 GiB 安全余量），不故意填满系统盘。最终 JPG 与原始合成输入保留；只删除明确由此测试创建的提取/私有副本。小型 JSON 证据进入 `artifacts/m5/`。
- 压力脚本仅采样父 Node RSS，明确不含 FFmpeg/图像 worker/Electron/系统缓存；不是全系统内存峰值或 UI 响应验证。源为原生编码的实际长合成流，不冒充摄像头实录或手机验收。用例时长和磁盘预算不构成产品媒体上限。

压力和 packaged 短用例终态均已核验通过；新 NSIS 和手机包仍在进行，未提前验收。

## 已通过：真实大/长流后端

完整记录：`artifacts/m5/Motion Photo M5-VW6n3s-passed.json`。真实数据保留在 `%TEMP%/Motion Photo M5-VW6n3s`，不是用户原片，暂未删除原始合成输入和最终 JPG。

| 检查 | 大体积组 | 长时长组 |
| --- | --- | --- |
| 实际输入字节 | 4,565,036,362 | 178,697,256 |
| 实际最终 JPG 字节 | 4,565,044,047（约 4.25 GiB） | 178,705,232 |
| 实际视频时长/包数 | 380 秒 / 11,400 视频包 / 17,813 AAC 包 | 7,200 秒 / 72,000 视频包 / 无声 |
| JPG SHA-256 | `8bc26b3a989162752fd2b71d768ef5db5ab01c3e9b432ddacb7fafb632209292` | `76dc52709eaf888371484e60737ed697a9f266286911fec4723e2ac47113064f` |

均经过正式原画草稿（压缩负载/时序校验、完整解码）、封面、发布、独立提取、完整解码、MP4 SHA-256 对照、原始合成输入前后哈希不变；完整 mux 后在提交前取消没有伪成品、工作区/恢复记录清空。大组为 96 Mbps 有效 AVC filler 包的低分辨率合成流，非 free-box/sparse 凑大小，也不冒充实际摄像头高分辨率压力。长组是实际 10 fps 编码 2 小时，并非只写长 duration。

两组合计 229,259 ms。父 Node RSS 250 ms 采样峰值 158,703,616 字节（约 151.35 MiB），**不是**原生子进程、Electron、系统缓存或全系统峰值。没有据此声称整体内存仅此数值。

**打包 UI 压力 `bc3ffa445` 退出 0，1 项实际压力通过（1.6 分钟）。** 可选 `tests/e2e/stress.spec.ts` 要求真实已通过 manifest 和确切新 EXE，不替换小素材，未设置参数明确跳过。结果在 `artifacts/m5/ui-1792663025289-e8c459d5/result.json`：

- 从 4,565,036,362 字节源上请求 `bytes=4294967296-4294967359`，返回真实 206 / 正确 Content-Range，64 字节与独立文件高位偏移读取一致；不是只测数字计算。
- 大源末尾 379 秒、两小时源末尾 7199 秒精确定位通过；两个兼容代理实际各 3 秒，没有转完整长片作预览。
- 大源分析取消实测 57 ms 返回“未发布新成品”，无输出；这是本机一次观察，不是全部设备响应 SLA。
- 两个尾部剪辑分别 378–380 秒与 7197–7200 秒，打包 UI 实际保存最终 JPG，独立提取/完整解码通过、原始输入哈希未变、缓存/日志清空。
- Renderer heartbeat 1,816 次、最大 gap 219.5 ms；179 个 Electron metrics 样本的最大同时 working-set 总和 786,726,912 字节（约 750.28 MiB）。包含共享页重复计数，不含独立原生工具或系统缓存，不称全系统峰值。
- 不是全长/全体积 GUI 导出；不能从后端通过自动推出该路径，也不是干净安装、真实摄像头高分辨率或手机证据。

## 候选静态证据（不是运行/许可验收）

`candidate-evidence.json` 位于上述唯一候选根目录，`scripts/m5-package-evidence.ts` 类型检查及实际执行通过：

- EXE 249,797,632 字节，SHA-256 `5beebfa8ef00629a3bc20f4a0b181a52c5a4be5fe41e561e35962b62f4c3cb94`，实际 Authenticode **NotSigned**。
- app.asar 15,144,805 字节，SHA-256 `bfe0f4c2186c49de3fc3ece18169c6136fe2502273fc57c41bd273e4590037d1`。
- 实际归档 10 个 npm runtime 包、9 个对应通知路径；saxes 未见完整通知仍是阻塞。保留 Electron/Chromium 两份通知并记录哈希。不能把 SPDX 字段/文件存在当成全文审查。
- Sharp `.node`、libvips 两个 DLL 确在 app.asar.unpacked，记录各自实际大小和哈希；这里只是静态确认，执行是否成功看运行门禁。
- 重新计算 M1 installer SHA-256，仍为 `9700d9c87fde063f9ddc36deea254f7fb978c5d774890ea55e67ae6670a44a7e`，回滚原包未改动。
- 静态脚本曾修正 asar API 必须传 ListOptions 及 Windows archive-relative 路径需 normalize 的检查器问题；没有为绕过运行失败改动产品。

## 正在准备的人工验收交付物

- `b76680f8d` 退出 0：对已实测候选使用 `--prepackaged` 生成 `artifacts/desktop/m5-installer-20261022100756853-463f55ef/MotionPhotoStudio-M4-dev-0.1.0-win-x64-setup.exe`，235,714,634 字节，SHA-256 `f1307a9ec1a870b1b3cc294bc82573c9e611eae14b26ced5e401bfe0e91731ba`。实际 Authenticode **NotSigned**，不能按构建日志里的 signing 步骤宣称已签名。EXE/asar/M1 哈希前后未变；只是 NSIS 生成，不是安装/卸载。人工表见 `docs/clean-windows-checklist.md`。
- 载荷检查首轮 `bf06b6fe2` 失败在不存在的旧 `node_modules/7zip-bin/.../7za.exe`，尚未读安装包。查明 electron-builder 26 改用缓存 toolset，现有精简 7za 24.09 不含 NSIS 格式，不能拿它代替完整解包器。没有据此判定安装包损坏或声称一致。
- 检查器改为显式 `--sevenzip`，验证 NSIS 能力并记录工具路径/版本/哈希。`b9889f308` **退出 0**：使用本机现有完整 7-Zip 25.01 x64 只读解包自生成 NSIS/x64 载荷，实际内嵌 EXE、asar 和三个 Sharp 原生文件哈希与已运行候选完全一致。记录见安装包目录 `payload-evidence.json`。没有新安装解包器、没有增加用户 runtime 依赖、没有执行安装器或改注册表；不是干净安装/卸载。#18 已闭合。
- `b014dad21` 退出 0：仅用合成时钟与每秒短音，生成 `artifacts/m5/phone-20261022101218500-6f4e09c9/phone-kit/` 内唯一 5 张 C-profile JPG（3/15/60/600秒、原画/普通、1.2秒对应帧、360×360 方形裁切、360×640 无声竖屏独立透明封面）。每个均走正式草稿/发布链，独立提取/全解码/哈希通过；包括真实 600 秒普通编码/AAC链，不只有长输入读取。约 80.25 MB。manifest/phone-feedback.md 在同级；手机状态仍 NOT_TESTED。仅新 artifacts/系统临时工作目录写入，M0 私人样本/反馈未改。
- 已另运行 `scripts/m5-install-inputs.ts` 并通过类型/实际全解码，`desktop-test-inputs/` 含约6秒横屏时钟短音 MP4、3秒旋转无声 MP4、透明 PNG，哈希在 `desktop-inputs-evidence.json`。给干净 Windows 复制这些**输入**及 NSIS，不能把生成的 Motion JPG 当作一期支持的可编辑输入。原始合成工作目录和5张手机包不变。

## 官方原文：仍阻塞

本次 M5 使用 `fetch_content` 对原始官方 URL 重新尝试（responseId `mvjbp1zspa1qba`）：

| 官方入口 | 本次结果 |
| --- | --- |
| https://developer.android.com/media/platform/motion-photo-format | 198.18.0.192，fake-IP/SSRF 安全检查阻止 |
| https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2003 | 198.18.0.193，同上 |
| https://ffmpeg.org/ffmpeg.html#Stream-copy | 198.18.0.194，同上 |

没有取得正文，没有修改安全白名单、切换 IP 或规避检查；不把搜索摘要、M0 手机通过或自己的实现当作规范原文复核。工具建议放宽安全范围不是自动授权。原引擎本机目录只见 `bin/`，没有可供原文复核的随包文档。

可由用户将官方完整 HTML/PDF（含页面 URL、版本/获取日期）保存到 `private-materials/official-docs/` 后再做离线逐条核对（该目录已忽略，不将原始网页/潜在账号信息推到公开 GitHub），并注明离线副本的来源与未在线复核边界。用户本次确认暂时无法提供副本。原文复核是 mandatory M5，当前仍未完成（任务 #5），没有据此自动豁免。

## 尚未通过的发布门槛

- 新候选 packaged runtime 与 NSIS 生成已有本轮证据；干净离线 Windows 安装/运行/卸载仍未执行。用户确认只能使用当前开发机，没有独立干净电脑/VM；开发机额外测试不能替代该门槛，也没有自动执行安装器或改注册表。
- 新完整导出链在指定 Redmi K70E / OS / Gallery 上原文件 USB 转移复测：标志、长按、封面、方向、音轨、重开相册、3 秒/15 秒/1 分钟/10 分钟/更长实际表现；不要从短片推断长片。
- 已记录真实 >4 GiB/两小时合成流、打包 UI 末尾定位/取消及有限 RSS/working-set 采样；仍未覆盖摄像头高分辨率长片、全长/全体积 GUI 导出、全部原生子进程/系统内存峰值或断电。故障注入 ENOSPC 不叫真实填满磁盘。
- FFmpeg 精确构建及附属库对应源码/构建资料/许可交付、saxes ISC 原文、Sharp/libvips/LGPL 全部通知、来源/对应源码及替换义务仍未闭合。UNLICENSED/private 项目、独立进程调用、仅附 GPL 文本均不是公开分发授权。
- 目前未签名，未购买证书；不能伪称已签名或绕过 Windows 安全策略。

本阶段未完成前，不标记计划第 6 步，不将内部候选称作已验收正式版。用户要求验收后创建公开 `TianJiaJi/motion-photo-studio`；当前 gh 身份已核对，但仓库尚未创建/推送。没有因公开意愿而擅自豁免规范、许可、干净环境和手机阻塞。私人样本、artifacts、会话、凭据和原始人工材料均已在 ignore 范围，实际发布前还需审查拟提交内容。
