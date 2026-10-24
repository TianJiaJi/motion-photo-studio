# Filmcraft 整体设计借鉴评估

## 0. 范围与结论

基于本地 `样本/参考代码/filmcraft/` 的架构文档和关键源码做只读调查：容器/媒体接口、Windows 解码集成、帧任务调度、播放音频、缓存、编辑状态、持久化、性能观测和测试。不是逐行审计全部工作区；未编译运行 Filmcraft，也未做同机同素材性能对比。文档中的性能数字不视为本机结果。没有复制实现或修改参考项目，没有研究其底层编解码算法来实现格式。

**最值得学的不是纯 Rust、egui 或功能数量，而是：单一媒体身份/时间来源、当前画面优先的有界工作、预览与精确输出分层、可解释的运行状态。** 我们的全片验证型导入需要调整，但现有原始 PTS、ACK、取消、资源所有权和发布安全不能随之丢弃。

优先级：P0 直接影响主要使用流程；P1 紧随其后的稳定性/维护性；P2 瓶颈测清后或产品扩展时再做。以下是设计建议，不是已经实施或新批准的执行计划。

## 1. 分层地图

Filmcraft 的主线：

```
容器随机访问 / 样本索引
    ↓ 压缩样本 + 时间戳
媒体源 / 解码器接口 / GOP 状态
    ↓ 带时间与色彩信息的帧
渲染与帧任务调度
    ↓ 当前画面、预取、缩略图
UI / 自动化客户端
```

编辑引擎、项目数据、媒体源、平台 FFI 分开；UI 不是所有业务状态的唯一持有者。`docs/architecture.md` 列出 L0–L6，层级通过 `cargo xtask layers` 检查。对我们应借鉴职责边界，而不是照搬几十个 crate 或重写 Electron。

## 2. P0：消除两套读取路径的全片对账

**证据：**
- `crates/codecs/src/mp4.rs::Mp4Source::open_reader`（约 214 行）：只先读取索引、样本按需取。
- `crates/engine/src/media_pool.rs::open_file`：随机访问 reader、共享源。
- `crates/platform/README.md` Windows 部分：自己读取的压缩样本直接喂给 MFT，明确没有 Source Reader 和第二个 demuxer。
- `crates/platform/src/media_foundation/mft.rs`：输入设置 sample time，经 `ProcessInput` 送入，输出读取 sample time。

**我们的差异：** `native-import.ts` 先由 FFprobe `-show_frames` 全片扫描，再由 `frame-index.ts::mapNative` 驱动 MF 全片逐帧核对；原生 `media.rs` 使用 `MFCreateSourceReaderFromByteStream`。`session.ts::prepareNative` 等两者与所有音轨准备结束后才创建播放会话。

**借鉴：** 普通 MP4/MOV 由容器层提供一致的原始样本身份、PTS/DTS、轨道 ID、关键帧和 edit list 语义；Windows 视频后端消费这些样本，不再依赖两套解复用输出事后全片对账。顺序播放复用解码状态，定位从合法随机访问点前进。

这补充了 `native-import-latency-analysis.md`：仅把旧扫描搬到后台不是最彻底的解决方法，**减少双重时间轴才是长期方向**。但是直接驱动 MFT 工作量明显大于调整就绪状态，涉及输入/输出背压、B 帧重排、flush/drain、HEVC CRA 等边界；应先做受控 MP4/MOV 路径原型，再迁移，不能一次换掉所有格式。

**必须保留：** 任意时间基、VFR、非零起点、B 帧、edit list、音轨身份和最终源 PTS。容器 sample/packet 与显示帧不能无条件一一等同，也不能用平均 FPS 或一次偏移校准冒充完整正确性。全片 oracle 放在验证工具，不在正常首帧关键路径；不能播放后继续后台 FFprobe 扫描来绕过零交互媒体进程约束。

## 3. P0：解码与显示几何分开，减少不必要的兼容转换

**证据：** `crates/codecs/src/mp4.rs` 读取 rotation、clean aperture、pixel aspect；构造 GOP 缓存时传入 rotation/crop，附有纯 90/180/270 度旋转测试。`docs/architecture.md` 的 Pixel aspect ratio 部分把显示几何与媒体解码分开。

**我们的差异：** `native-import.ts` 将非零旋转、非方形像素等直接并入整片兼容转换条件。这会让本可原生解码的竖屏手机素材也支付额外导入成本。

**借鉴：** 将可支持的旋转、可见裁切和 SAR 作为逐帧变换/显示变换，复用同一套几何定义供预览、裁剪和导出核对。HDR 同意和色彩转换是另外的能力判断，不应趁此取消。任意镜像/非纯旋转矩阵也不能宣称已经支持。

## 4. P0：首帧优先，播放预取有上限，缩略图不能争主路

**证据：** `crates/ui-egui/src/frames.rs::request_job / schedule_playback / playback_plan`：
- 当前画面优先，随后播放预取，最后缩略图。
- 相同请求去重，取消过时的请求。
- 同一帧只因编辑 revision 改变时，允许已有工作完成，避免每次刷新都取消导致一直没有画面。
- 有短预热机制（该 FrameServer 的常量为 6 帧、最长 0.5 秒），不是扫描整片。
- 负载超出实时能力时，选择仍来得及完成的任务，避免所有任务都排队迟到。

**我们已有：** native `control.rs` 的有界邮箱/低优先级任务抢占，renderer `preview-controller.ts` 的同拖动世代与跨世代抢占，`native-timeline.ts` 的在途/等待画面上限。不能说这些需要从零重写。

**缺口与建议：** 正常播放仍是主进程循环“读时钟→查索引→请求画面→再读时钟”，播放前只等首帧 ACK；现有 `prefetch()` 在 playing 时不运行。可评估短时窗、字节有界的顺序预解码，当前交互抢占预取，缩略图不扰动播放 reader。不要照搬其 14/24 帧预取量或 2–6 工作者，多开 MF 解码器可能反而增加内存和 seek。

停止拖动后的最终定位、步进和封面仍必须精确；不能用“丢帧追赶”规则替代它们。

## 5. P1：缓存不仅是一个 LRU，还包括解码器与在途帧

**证据：**
- `crates/ui-egui/src/frames.rs::FrameKey` 包含 target/frame/size/revision/draft。
- `crates/media/src/cache.rs` 按字节计费，超额后腾出一段余量。
- `crates/codecs/src/gop.rs` 的 Pool 同时跟踪解码器和全局帧字节；近期、空闲、后台任务不同待遇，不能将其中的软限制理解成所有时刻的进程内存硬上限。
- `crates/engine/src/perf.rs` 分别报告 liveDecoders、cacheMB、planePoolMB。

**我们已有：** 不同分辨率缓存键、208 MiB 前景/16 MiB 缩略图像素预算、条目上限、在途 ACK 槽位；缩略图文件缓存也限制为 64 条。

**建议：** 保持这些硬界限，增加解码器/reader 存活数与 MF/进程总内存的分项观测；将当前画面、近邻、缩略图和空闲 reader 的保留策略明确化。224 MiB 是应用像素缓存预算，不是整个 helper 进程承诺。不能照搬 Filmcraft 的 768 MiB/1 GiB 等预算到单素材小工具。

## 6. P1：音频解码与设备供数解耦

**证据：** `crates/ui-egui/src/play_ahead.rs`：混音/解码生产线程向有界 ring 写数据，设备 callback 只取样本；欠载补静音且跳过相应已过去的源区间，计数可查。其 LEAD_S=0.2 是预缓冲取舍，不代表物理音画延迟必然 200ms。

**我们的差异：** `native/preview-engine/src/audio.rs` 同一工作循环既 `source.sample()`、分配 PCM，又给 WASAPI 填充缓冲、更新设备时钟。视频解码已在别的执行路径，但音频读取阻塞仍可能影响供数和时钟更新。

**借鉴：** 生产端解码/对齐/补间隙，消费端只供数；音频设备时钟仍为主时钟，不能换成已排队样本数。暂停/切轨需世代隔离并清空旧数据，所有缓冲与线程必须可取消、可确认退出。

这是结构性风险改进，**不是认定此次漏第11秒标记就由音频造成**：现有失败报告音频 underruns 为零，定位仍需各阶段耗时。

另外，Filmcraft 的 `play_ahead.rs::StopOnDrop` 设置停止标志；不要借鉴成我们可以不等待线程退出。我们删除文件前确认 join/句柄释放的保证必须保留。

## 7. P1：目标位置、呈现位置和编辑文档是三种状态

**证据：**
- `crates/engine/src/lib.rs::Session::execute / edit / edit_merged`：统一命令入口，编辑副本成功后提交，连续手势可合成一步撤销。
- `crates/ui-egui/src/source_playback.rs` 明确播放是呈现状态，不是项目编辑。
- `crates/ui-egui/src/perf.rs` 同时暴露实际画面 frame/revision 和 playhead/projectRevision。

**我们的差异：** `Editor.tsx` 同时维护 clip、position、frame、target、displayed、playIntent、nativeReady、多个 busy 状态。之前精确定位输入被异步状态覆盖，说明这些边界需要更清楚，而不只是继续堆 effect。

**借鉴：** 用小型明确状态模型区分：
1. 用户输入草稿/意图；
2. 已提交的剪辑、裁剪、音轨、封面选择；
3. 解码与实际绘制确认。

鼠标、键盘和精确输入共享操作语义；按钮的可用条件由能力/操作状态推导并给出原因。无需完整 NLE 项目模型，也无需新增对外 TCP 控制服务器。现有 trusted IPC 边界保留。

## 8. P1：预览降质和最终准确性分层

**证据：** `FrameKey.draft`、`media/src/cancel.rs::with_draft`、`docs/architecture.md` 的 draft decoding 与 CPU reference/GPU parity；预览草稿结果不服务精确请求。

**我们已有：** 拖动 640、最终定位 960，封面/导出使用原始 PTS 重解码，HDR 同意保护真实画面。

**借鉴：** 若以后引入更多预览质量档位，缓存身份包含影响画面的质量/变换；导出和封面不能误用近似结果。可显示旧的已确认画面等待新帧，但必须保留旧画面的真实 PTS，不能标为新的目标时间。参考项目“nearest cached”与“exact ready”不是同一个概念。

不要照搬其软件解码器内的跳过滤波等算法；MF 后端也未必暴露相同能力。当前优先改善导入和调度，而不是新增近似解码。

## 9. P1：性能应当是产品内的可查询状态

**证据：** `crates/engine/src/perf.rs`、`crates/ui-egui/src/perf.rs`、`frames.rs::JobRecord`：请求命中、seek、解码样本数、排队/源读取/渲染、UI、实际显示、解码器数量、音频欠载都可查询。

**我们的问题：** 已有若干计数与外部测试脚本，但排查停顿时仍需临时注入 stdout 观察器；导入耗时早已记录，未形成首帧阻塞的优先级和阶段预算。

**建议：** 默认收集轻量计数，显式开启有界时序记录，敏感路径默认不导出。至少分出：
- 导入元信息、索引、解码器打开、首帧、音频就绪、缩略图；
- 请求排队、解码、像素转换、传输、Canvas 绘制、ACK；
- cache hit、decoder reopen、过时任务、待确认字节、进程内存。

硬解证明与 GPU 利用率分开：创建 D3D manager 不是硬解证据。其平台说明要求真实 DXVA 能力及输出 texture；我们的 `hardwareDecodeVerified=false` 目前是诚实的状态，不能靠开关改为 true。

## 10. P1：评估像素管道，而不是先重写 UI

**证据：** Filmcraft `docs/architecture.md` 的 worker/GPU plan 分工，`crates/platform/README.md` 描述硬解帧仍读回 CPU；`docs/gaps.md::G5` 明确零拷贝尚缺。

**我们的额外边界：** helper RGBA → 管道 → Node Buffer → Electron IPC → renderer Canvas。`native-preview.ts::consume` 对分块持续 `Buffer.concat`，有重复复制/分配的成本，是否是此次停顿原因尚未测明。

**建议顺序：** 测量各段 → 有界整帧组装/缓冲租约、减少重复复制 → 如确为瓶颈，再评估 NV12/P010 + GPU 色彩转换或共享传输。理论上 960×540 RGBA 60fps 原始载荷已约 124 MB/s（不含额外复制），不能只比较解码器 FPS。

缓冲复用必须保证已确认帧/封面读取期间不被覆盖，不能破坏现有 ACK 所有权。新 GPU 路径要有颜色、range、aperture、SAR、旋转和 HDR 的参考对照。无须因此改成 egui，也不能声称 Filmcraft 已实现零拷贝。

## 11. P2：轻量会话恢复，而非把缓存当用户作品

**证据：** `crates/engine/src/autosave.rs`：不可变项目快照交后台写入、去抖且有最大保存间隔、OS 锁区分活跃/遗留恢复会话；`Session::edit_merged` 合并连续操作。

**借鉴：** 若需要恢复裁剪区间、裁剪框、封面 PTS 和导出设置，保存小型编辑会话即可，不保存解码像素；与可丢弃缓存分开。可增加一次拖动一步撤销，不必引入完整多轨项目格式。

**不照搬：** `media_watch.rs` 会自动刷新变化的源文件，这适合 NLE 的增长文件流程；我们承诺原片身份一致、最终封面与原始 PTS 对应，不能自动把替换后的文件当作原片继续输出。继续明确报错/要求重新导入。现有所有权标记、清理 journal、拒绝链接/无标记历史数据删除的规则也不放松。

## 12. P0/P1：验收以用户路径组织，不以功能数量组织

**证据：** `docs/testing.md` 与 `crates/ui-egui/tests/perf_ui.rs` 描述分层测试、按住拖动时仍有画面、完整播放调度器的性能脚本；FFmpeg oracle 有强制模式，缺工具不应静默算通过。

**应借鉴的指标：** 导入到首帧、导入到可播放、点击播放到起音、第一次定位、连续拖动新画面、释放后的精确帧、暂停/关闭、导出正确性。将这些连成用户故事，而不是只测已经准备好的缓存命中。

**我们的保留项：** 固定随包工具、真实系统 pointer capture、确切 ZIP 资源/应用身份、真实素材、失败记录及源文件未改。无头命令测试补足状态覆盖，不能替代实际桌面操作。

Filmcraft 的性能文档区分 wall time、CPU time、seek/decoded/waste 等结构计数；我们应对相同素材、相同程序身份做前后比较。即使短期目标未达标，也能看出到底消除了哪一段重复工作。

## 13. 必须警惕的参考项目差异

1. **隐藏窗口口径不同。** `frames.rs::PlaybackMeter::resync` 不把隐藏期间算 dropped，`panels/monitor.rs` 恢复时使用该路径；这不证明其隐藏期间仍逐帧呈现。`disable_video_in_background` 在已搜索 Rust 树中只找到设置字段和默认值，未找到直接使用该字段的播放分支，不能只凭设置名称宣称行为完整。
2. **不能改口径来抹去我们的失败。** 当前最小化测试要求完整60标记且偏差≤80ms；若产品决定隐藏时暂停/不绘制，需明确改变产品契约和相应测试，保留旧失败，不得暗中排除样本。先优先解决用户指出的导入阻塞。
3. **单一 Tick 不是任意源 PTS 的万能替代。** Filmcraft 使用 254016000000 ticks/s；可学习整数/有理数时间，但照搬进 JavaScript Number 约 9.85 小时便到安全整数量级。继续原始整数 PTS + 有理时间基，必要时 BigInt/字符串；UI 时间显示和媒体身份分开。
4. **文档有明确未完成项。** 本地 `docs/gaps.md` 自述 Windows/Linux 运行验证、真实媒体语料、硬件和稳定性缺口；这是维护者声明，不是本次复现。不能以架构漂亮推导所有格式、设备和边界均可靠。
5. **不要照搬全栈自研。** 自研所有编解码器、多轨混音、特效、AI、跨平台和 MCP，远超单素材实况图片工具需要。也不改变本项目已确定的固定随包导出引擎与安全边界。

## 14. 建议执行顺序与验证边界

| 顺序 | 工作 | 何时算有证据 |
|---|---|---|
| 1 | 分阶段导入指标、能力状态；明确普通格式快速路径 | 能指出首帧前每段耗时/解码量；不让“验证中”笼统冻结一切 |
| 2 | 常规 MP4/MOV 容器索引 + 单一时间来源 + 按需解码原型 | 同一真实素材不再首帧前全片解码；首帧/可播放显著改善，PTS、VFR、B帧、edit list 等回归不退化 |
| 3 | 常见旋转/SAR 逐帧处理，减少兼容转换 | 竖屏/SAR 源不无谓转码，预览裁剪与最终原片输出一致 |
| 4 | 当前画面优先、短预取、取消去重、解码器预算 | 长GOP/4K第一次定位与播放改善；队列、内存和关闭时间仍有界 |
| 5 | 音频生产/消费分离、像素管道按测量优化 | 可归因地减少停顿/欠载/复制；不改变源身份、ACK和释放保障 |
| 6 | 小型编辑状态/手势撤销、会话恢复、测试分层 | 草稿不被后台状态覆盖；命令/鼠标/键盘一致；失败不破坏原片和编辑数据 |

不把“首帧可以出现”偷换成“所有精确操作已经可信”，也不把“全片扫描移到后台”当作性能修复。应让普通播放与所需区间的精确操作真正按需完成，同时单独报告兼容格式、物理音画和未验证硬件的限制。

本次仅完成研究与建议。原计划第10步仍未完成，旧候选和音画失败记录仍有效，不因这份设计分析而变为通过。
