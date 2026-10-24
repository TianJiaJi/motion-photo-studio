# M1 本地验证记录（内部基础验证完成）

## 范围与实现

- Electron 45.0.0 + React 19.3.1 + TypeScript 5.9.3，Windows x64。
- 固定配套 FFmpeg/ffprobe：`2026-05-21-git-0857141823-full_build-www.gyan.dev`。
- 原生工具完整性清单：`app/resources/engine-manifest.json`，包含两个文件的大小和 SHA-256。
- 主进程/预加载/渲染器隔离；bridge 不暴露任意 invoke、路径或命令，只有只读安全状态、应用状态、诊断任务与取消。
- 单活动媒体任务，进度事件、退出中取消、受所有权标记保护的临时目录清理。
- 内部验证界面尚无视频编辑与实况导出功能，不能替代 M2–M4。

## 已完成的本地检查

| 项目 | 结果/证据 |
| --- | --- |
| 配套媒体引擎复制与固定 | 任务 b9716055f 退出 0；非 PATH 运行时依赖 |
| TypeScript strict | 最近一次检查通过；第三方声明 skipLibCheck，项目源码仍检查 |
| 单元测试 | 38/38 通过（b53cf0b74 中），含 IPC 参数/资源路径、引擎缺失/篡改、目录所有权、任务取消 |
| 媒体集成 | 4/4 通过（b53cf0b74 中），本次使用固定配套引擎 |
| Electron/Vite 三部分构建 | main、preload CJS、renderer 均成功 |
| 缺失引擎界面 | Electron 实际启动后显示不可用，禁用诊断按钮，没有回退 PATH |

## 桌面与安装产物验证

- 桌面开发构建的 2/2 Playwright 测试已通过（任务 `b1c2abb4d`）：安全状态、离线自检、取消、退出清理、缺失引擎失败路径。
- NSIS 内部安装产物已生成：`artifacts/desktop/MotionPhotoStudio-M1-0.1.0-win-x64-setup.exe`，229,150,827 字节。
- 安装包 SHA-256：`9700d9c87fde063f9ddc36deea254f7fb978c5d774890ea55e67ae6670a44a7e`；PowerShell Authenticode 状态 `NotSigned`（不把构建日志中的 signing 阶段当作签名成功）。
- Electron/Chromium 许可文件已确认存在于 `win-unpacked/`；界面截图 `artifacts/desktop/development-smoke.png` 已人工查看。
- 打包后的 EXE 在去除 Node/FFmpeg PATH、renderer 离线的测试环境运行通过（任务 `b90adea0b`，退出 0）：1 项完整自检/安全隔离/取消/退出清理通过，1 项缺失资源用例按设计跳过（该用例已由开发构建独立通过，不计作打包通过）。截图 `artifacts/desktop/packaged-smoke.png`。
- M1 计划第 2 步已完成。没有执行静默安装、修改安装注册表或干净离线虚拟机安装/卸载测试；这些保留最终发布验收。

此前桌面测试失败停在测试测量方式：Electron 45 类型未提供旧的 getLastWebPreferences；隔离世界注入脚本也不能直接访问 preload 私有 process 绑定。已改为由实际 preload 只读暴露 `process.sandboxed/contextIsolated`，并用主进程 OS sandbox 指标交叉验证，未降低窗口安全配置。

## 不作出的声明

- 不把构建成功当作真实桌面自检通过。
- 不把打包 EXE 测试当作干净离线虚拟机安装/卸载验收。
- 不宣称全部视频编辑/实况导出功能完成。
- 本机引擎快照未完成公开分发的完整对应源码与附属库许可审查，内部安装包不可公开分发。
- 官方格式原文复核、最终产品真机回归及长片/大文件测试仍在 M5。
