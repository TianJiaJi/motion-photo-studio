# 导入阻塞播放：与 Filmcraft 的路径对照

## 结论与范围

当前明显的导入等待主要有明确的架构性来源：将全片视频/音频核对作为创建播放会话的前置条件。不是原生播放天然需要先解码整片，也不能归因于用户机器或 Electron。本次为源码调查，不是 Filmcraft 与本程序的同源同机计时对比；未修改生产逻辑，不能声称启动性能已改善。

## 当前实现的串行前置工作

- `app/src/main/media/native-import.ts::prepareNativeMedia`：等待源帧索引、原生全片映射、音轨准备，再返回。
- `app/src/main/media/frame-index.ts::buildFrameIndex`：FFprobe `-show_frames` 遍历整片，记录 PTS、帧时长、关键帧。
- 同文件 `FrameIndex.mapNative`：`scanFrames` 循环直到末尾，逐帧比较源 PTS 与 MF 时间，再核验首/中/尾定位；完成后才 `mapped=true`。不是只读容器已有样本表。
- `native/preview-engine/src/main.rs::Command::ScanFrames`：反复取视频 sample，直到 EOF。
- `app/src/main/media/native-audio-import.ts::prepareNativeAudio`：遍历所有音轨，源端整轨扫描、原生端整轨扫描；映射/连续性不符时制作整轨 PCM 并再核验。并非只准备用户当前选择的音轨。
- 兼容路径还可能整片转码，并再次核验映射。不能把所有素材的耗时都归咎于转码：正常直读路径也有上述全片扫描。
- `app/src/main/media/session.ts::prepareNative`：以上全部结束才创建 `NativeTimeline`；`nativeControl` 在此前拒绝播放。
- `app/src/renderer/src/Editor.tsx`：取得 native ready 后才请求首帧。缩略图是此后的另一条任务，不是上述长等待的必要理由。

已有旧候选四份真实素材的首次可见时间约为 42.85/54.13/14.68/92.41 秒（见 `docs/native-preview-acceptance.md`，相应旧候选与证据编号需保持绑定）。这些数值不是各阶段独立剖析，也不是当前新候选或 Filmcraft 的实测结果，但此前应将此问题视为主要体验缺陷，而不能只记录为“准备耗时”。

## Filmcraft 的不同点

- `样本/参考代码/filmcraft/crates/engine/src/media_pool.rs::open_file`：优先走随机访问 reader，缓存共享媒体源。
- `crates/codecs/src/mp4.rs::Mp4Source::open_reader`（约 214 行）：明确采用“only the index is read now, samples on demand”；从容器解析轨道/样本表及媒体信息，而不是先解码完整视频核对另一套解码器的时间轴。
- `crates/codecs/src/lib.rs::reader_openers`：容器索引先读取、样本按需读取。
- `crates/ui-egui/src/frames.rs`：后台工作线程按“当前画面 → 播放预取 → 缩略图”排序。

因此不是 Filmcraft 不要索引，而是其常规 MP4/MOV 路径读取容器索引、按需解码；我们把两套时间轴的全量验证放进了播放门槛。该源码差异不能外推为 Filmcraft 所有格式都能瞬时打开。

## 建议的改造方向（尚未实现）

1. 普通可原生支持的 MP4/MOV：容器元数据/样本时间表、所选轨道身份、解码器初始化和首帧构成快速就绪路径；首帧与可播放分别计时，不等整片核验。
2. 原始 PTS、关键帧、B 帧呈现顺序、edit list、非零起点、VFR 必须保留。不能改成平均 FPS 推算索引，不能默认一个 packet 就是一个输出帧，也不能把一次首帧偏移校准当作整片映射证明。
3. 将源样本身份与解码输出的核对落在请求附近的有界区间；已验证区间、未验证区间、失败状态显式表示。精确步进/封面/导出仍只使用可信的真实源帧身份。
4. 正常播放不预扫描全部音轨；按所选轨道建立音频流并在运行中正确处理时间戳、延迟与间隙。切轨不能误用其他同形状音轨。
5. 缩略图/缓存预热为低优先级，不能阻挡首次播放。全片 oracle 扫描留在测试/诊断；若确需增量索引，应由常驻原生能力完成，不能播放后在后台偷偷继续启动 FFprobe/FFmpeg、借“准备”名称绕过零交互进程约束。
6. 真正需要兼容转换的格式单独提示，不用它决定普通原生格式的导入体验。
7. 以同一批真实素材重新衡量导入到首帧、导入到可播放、播放起音以及定位/步进/封面一致性；不承诺尚未测得的秒数。

这涉及就绪状态、索引抽象和原生时间映射的调整，不是仅取消一个 `await` 或添加进度条。原音画失败证据继续保留，但用户反馈的导入延迟应优先解决。
