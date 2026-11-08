# v0.1.5 发行执行记录

## 已保存的交互实现

`0631e91546baf03b3583788a32b9ab5e3ce17a8c` 已以 TianJiaJi 身份提交并推送。提交前 `be99da1c8`：类型检查、167 单元、106 集成、构建、20 桌面通过，1 压力测试缺素材跳过。详见片段侧栏与工作台记录。

## 发行规则与资源变更

- 版本及锁文件同步至 0.1.5；main 版本增加触发完整流程，普通提交只做源码检查。
- `docs/releases/v0.1.5.md` 通过 `--notes-file` 写入 Release 正文。
- 不再依赖未配置的引擎 URL 变量，不将开发机内部快照直接公开分发。新增固定源码的 Linux→Windows 引擎构建、对应第三方源码归档及 Sharp/libvips 来源核对。
- 原有媒体/原生/确切包验证门槛保留；新增侧栏、批量时长及即时预览也纳入确切包桌面测试。
- 在云端真实执行成功前，不宣称新引擎、来源归档或发行附件已经通过。

## 配置验证

- `bb00bef23`：类型检查、170 单元、应用构建与 JavaScript 语法检查通过；最后的发行规划 CLI 因从 app 目录启动、重复拼接 app 路径失败。
- 修正为按脚本位置定位仓库；补充从仓库根/app 两种工作目录启动的回归。随后类型检查和 4 项发行规划测试通过。YAML 解析和 Bash 语法检查通过。
- YAML 校验最初尝试未安装的 `yaml` 包失败，改用项目已有 `js-yaml`，没有增加依赖。

## 首轮云端来源检查

- `42458706037`（提交 `ad189da`）：版本规划通过；9 个固定仓库检出成功；引擎来源准备因锁文件使用 registry.npmmirror.com、脚本错误限定 resolved 域名而失败。未开始交叉编译、Windows 验证或发布。
- 修正为根据已核对版本构造官方 npm URL，继续严格验证原 lockfile SHA512，镜像地址不作为信任来源。补充实际锁文件与镜像 URL 回归，不接受版本漂移或未知完整性格式。

## 第二轮云端编译

- `42458988421`（提交 `3f6ca12`）：来源准备完整通过，包含实际组件版本/源码校验、Rust vendor 和 libvips DLL 对应 SDK 核对。随后 x265 CMake 报版本列表为空；其 Version.cmake 依赖 git describe，但按固定提交的浅克隆未携带标签。
- 补取精确 x265 4.1 标签并校验其解引用提交仍为固定 SHA；不改源码 pin 或放宽编译错误。源码附件附加上游认可的 x265Version.txt，支持没有 .git 的离线重建。
- 本地 gh watcher 曾因网络 EOF 退出；单独读取远端结果确认实际 workflow 也失败，未将监控错误本身当成云编译失败证据。
- `b279ddef6`：发行目录修复后的 171 项单元测试全部通过（在后来新增镜像回归之前）。

## 第三轮交叉链接

- `42459661572`（提交 `784c48d`）：来源准备与 x265 4.1 版本解析通过；x265 库编译后，FFmpeg pkg-config 链接检测失败。实际 config.log 的根因是 8/10-bit `setupAssemblyPrimitives` 未定义；两次 CMake 均提示 CMAKE_SYSTEM_PROCESSOR 为空，不是缺少已安装的 x265。
- 显式指定交叉目标 x86_64，保留汇编优化，采用静态 C/C++ 运行库；归档后直接核对两个命名空间的汇编入口符号，失败更早定位，不删除 HEVC 能力或绕过链接检查。
- 同时避免将 FFmpeg config.log 的初始环境变量转储放进公开源码附件；改附 config.mak/config.h，失败工件仅保留去掉初始转储的编译探测日志。增加诊断脱敏回归。已检查该失败日志，未发现 token/password/secret/access-key/private-key 命名的环境项；不宣称这替代完整安全审计。

## Windows 发行说明换行回归

- `42460773171`（提交 `b744f4b` 的普通 push 检查）：173 单元中 172 通过、1 失败。CLI 从真实检出目录读取发行说明时，Windows CRLF 不符合原来硬编码的 LF 标题后缀，误报缺少详细版本说明；不是正文缺失，也不是媒体引擎链接错误。
- 规划校验仅在内存中统一 CRLF→LF，仍严格核对版本标题和正文长度，不改写提交文件或 Release 正文。新增真实临时目录中 LF/CRLF 文件、根/app 双工作目录的 CLI 回归，并保留错误版本、空正文拒绝检查。
- 本地任务 `b5d4e35a0`：类型检查和全部 174 项单元测试通过，0 失败、0 跳过。云端最新提交与完整发行仍需独立验证。
- 同提交的完整引擎 run `42460776639` 与以上 push run 是不同执行，不将后者的测试日志当作前者引擎阶段的结果。

## 第四轮编译与许可收集

- `42460776639`（`b744f4b`）：FFmpeg、ffprobe 编译、链接和 strip 成功；随后未触发非系统 DLL 依赖拒绝。失败发生在下载 `https://www.gnu.org/licenses/gcc-exception-3.1.txt` 时返回 HTTP 404（退出码 22），不是这次编译失败。Windows 阶段仍未执行。
- 将 GCC 上游固定提交 `b71f1de6e9cf7181a288c0f39f9b1ef6580cf5c8` 的 COPYING.RUNTIME 原文随仓库保存，记录 Git blob 和 SHA256，并在源码准备阶段核验；许可文件用定向 gitattributes 保持 LF 原始字节。工具链通知收集移到昂贵编译之前，不再晚期联网下载该条款。
- `42461752520` 仍使用同一个失效 URL，已通过 API 取消，终态日志确认由 TianJiaJi 取消，避免明知会失败还重复编译；CLI cancel 一度报 invalid run-id，API POST 返回成功。此取消不是新的产品测试失败。
- 本地 `b802933b6`：Bash/JavaScript 语法、类型检查及全部 175 项单元测试通过（0 失败、0 跳过），包含原始许可双哈希核对与篡改/截断拒绝。新源码归档、Windows 媒体及确切包验证仍待云端执行。

## 第四轮云端：引擎构建首次成功，媒体门槛暴露真实失败

- `42462589018`（`abcf2f7`）：plan ✓、engine ✓（FFmpeg/ffprobe 交叉编译链接、来源归档、许可双哈希、Windows 端引擎/Sharp 来源校验全部通过，首次），Rust helper 构建/Clippy/测试、类型检查、175 单元、应用编译均 ✓。
- 媒体集成 107 项：95 通过、11 失败、1 文件挂起 56 分钟后撞 build 任务 60 分钟超时被取消。包装/确切包桌面验证未执行。监控的 EOF 退出是本机代理网络抖动，不是 GitHub 故障。
- 失败三类及确切根因：
  1. **3 项覆盖保护断言**（copy/encode/image 草稿）：源文件保护用 resolve 后字符串比较，云机临时目录含 8.3 短路径（RUNNER~1）与 realpath 长名不一致，guard 未命中，落到 wx 独占创建报 EEXIST。实际未覆盖任何文件，但保护消息未按预期触发——真实弱点。
  2. **4 项 + 1 挂起文件**（快速导入族）：新引擎（FFmpeg 8.1）生成/解码的音频样本时间形状触发 `preflightQuickAudio` 连续性判定（QUICK_UNSUPPORTED“音轨样本时间在预检窗口内不连续”），快速路径退回严格路径，fast-import/session 期望 quick 实际 strict 失败；quick-readiness“大原点差”测试期望被拒却成功，其准备好的 helper 未释放，子进程句柄挂住测试文件 56 分钟。这是发布门槛该拦住的真实兼容问题，必须真修。
  3. **3 项 WASAPI 播放族**：GitHub 托管 Windows 机无音频输出端点，helper 音频初始化报 `Element not found. (0x80070490)`。
- 处置（用户确认）：云端只跑跑得了的测试；需要真实音频端点的测试在无端点主机**能力探测后显式跳过并记录**，本地有端点时真实失败仍保持失败；下轮本机测试重点覆盖被跳过项。
- 已实现：源/输出身份改用原生 realpath（解析 8.3/大小写）规范化比较，含真实短路径回归；helper 新增 `--probe-audio` WASAPI 端点探测（镜像播放的初始化调用）；测试按探测显式跳过；“期望被拒却成功”路径现在会释放 helper，消除挂起；native-timeline 拆出静音时钟/异常终止（无端点可跑）与 WASAPI 播放（门控），fast-import 拆出 step/精确身份（始终跑）与播放（门控）；build 任务时限 60→90 分钟。
- 音频端点门控清单（无端点主机显式跳过，本地有端点必须全跑）：集成——`MF selects actual audio tracks…`、`audible playback advances on the actual WASAPI device clock`、`PCM-selected audio remains playable…`、`quick playback runs the selected audio track…`；桌面——`multi-audio UI…`、`one export dialog handles current/all clips…`、`one timeline holds independent range selectors…`、`offline editor imports through native dialog…`、`space toggles playback…`、`native desktop switches audio, replaces playing source…`、`minimized native playback…`、`native Canvas updates while held: ×2`、`HEVC60 plays continuously…`。无声时钟、step/封面身份、导出文件含声、HDR/清理/导入等不依赖端点的断言仍在云端执行。
- 已知产品限制（本次不改）：完全没有音频输出设备的机器上，带声预览会报原生音频初始化失败，而非自动改用无声时钟；导出文件的音轨不受影响。是否做“无设备→无声时钟+显式警告”的降级留待后续单独决定。

## 当前状态

完整源码引擎构建、云端媒体/打包/确切包桌面验证及最终 Release 附件核验待执行。开发机 0.1.5 构建仍使用旧的本地内部引擎，不作为新发行资源的证明。未重新验证冷/热性能矩阵、物理音画、多手机或缺素材压力项目。
