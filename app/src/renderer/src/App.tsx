import { useEffect, useRef, useState } from 'react';
import type { AppSnapshot } from '../../shared/contracts.ts';
import { Editor } from './Editor.tsx';
import { startupMessage } from '../../shared/startup.ts';
import './startup.css';

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [error, setError] = useState(''); const [requesting, setRequesting] = useState(false);
  const support = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let active = true;
    if (!window.motion) { setError('安全桌面接口未加载，请从桌面应用启动。'); return; }
    const accept = (next: AppSnapshot) => {
      if (active) setSnapshot(previous => !previous || next.revision >= previous.revision ? next : previous);
    };
    const unsubscribe = window.motion.onSnapshot(accept);
    window.motion.getSnapshot().then(result => {
      if (!active) return;
      if (result.ok) accept(result.value); else setError(result.error.message);
    }).catch(() => { if (active) setError('无法读取本地运行状态。'); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const busy = snapshot?.job?.state === 'running' || snapshot?.job?.state === 'cancelling';
  const ready = snapshot?.engines.state === 'ready';
  const previewReady = snapshot?.previewEngine.state === 'ready';
  const preparing = !error && (!snapshot || snapshot.engines.state === 'checking' || snapshot.previewEngine.state === 'checking');
  async function start() {
    setRequesting(true); setError('');
    try { const result = await window.motion.startDiagnostics(); if (!result.ok) setError(result.error.message); }
    catch { setError('无法启动本地检查。'); } finally { setRequesting(false); }
  }
  async function cancel() {
    if (!snapshot?.job) return;
    try { const result = await window.motion.cancelJob(snapshot.job.id); if (!result.ok) setError(result.error.message); }
    catch { setError('取消请求失败，请稍后重试。'); }
  }
  const labels = { running: '检查中', cancelling: '正在取消', completed: '自检通过', cancelled: '已取消', failed: '自检失败' };
  return <main className="app-shell">
    <header className="app-header">
      <div className="brand"><span className="brand-mark" aria-hidden="true">M<span>•</span></span><h1>实况工坊</h1><span className="workspace-label">视频工作区</span></div>
      <div className="header-tools"><span className="local-label">本地处理</span>
        <button className="quiet-button" aria-label="帮助与检查" onClick={() => support.current?.showModal()}>帮助与检查</button></div>
    </header>
    {error && <p role="alert" className="error app-alert">{error}</p>}
    {snapshot?.engines.error && <p role="alert" className="error app-alert">{snapshot.engines.error.message}</p>}
    {snapshot?.previewEngine.error && <p role="alert" className="error app-alert">{snapshot.previewEngine.error.message}</p>}
    {snapshot?.startupWarnings.map((warning, index) => <p key={index} className="warning app-alert">{warning}</p>)}
    {Boolean(snapshot?.cleanupIssues.length) && <details className="warning app-alert" data-testid="cleanup-notice">
      <summary>缓存检查：保留了 {snapshot!.cleanupIssues.length} 项待核查记录</summary>
      <p>旧缓存不会被当作原片重新加载。记录未被静默忽略；请在“帮助与检查”查看目录标识与保留原因。</p>
    </details>}
    {preparing && <aside data-testid="startup-status" className="startup-status" role="status" aria-live="polite">
      <strong>{ready && !previewReady ? '正在校验原生预览引擎…' : startupMessage(snapshot?.engines.check)}</strong>
      <p>正在校验本地媒体引擎，完成后自动启用导入。不会联网；首次启动或慢速磁盘可能需要稍候。</p>
      <progress aria-label="启动准备进度" />
    </aside>}
    <div className="app-body"><Editor ready={ready && previewReady} preparing={preparing} diagnosticsBusy={busy} savingReady={Boolean(snapshot?.savingReady)} /></div>
    <footer className="app-status"><span data-testid="engine-state" className={ready ? 'engine-ready' : ''}>{ready ? '引擎就绪' : snapshot?.engines.state === 'error' ? '引擎不可用' : '正在检查引擎…'}</span>
      <span data-testid="preview-engine-state">{previewReady ? '原生预览就绪' : snapshot?.previewEngine.state === 'error' ? '原生预览不可用' : '正在检查原生预览…'}</span>
      <span>内部测试版 · 请保留原片</span></footer>
    <dialog ref={support} className="support-dialog" aria-labelledby="support-title">
      <div className="dialog-heading"><h2 id="support-title">帮助与检查</h2><button aria-label="关闭帮助" onClick={() => support.current?.close()}>关闭</button></div>
      <p className="muted">素材只在本机处理，不上传。内部测试版，生成后请在目标相册确认效果。</p>
      <p className="hint">当前实测格式目标：{snapshot?.target.model ?? 'Redmi K70E'} · Android {snapshot?.target.android ?? '16'} · 相册 {snapshot?.target.gallery ?? '4.3.1.18'}。仅代表这一组版本，不保证其他设备兼容。</p>
      <details data-testid="diagnostics" className="diagnostics"><summary>离线引擎检查</summary>
        <p className="hint">仅在排查问题时使用；创建测试动画，不读取你的素材。</p>
        <div className="button-row"><button data-testid="start-diagnostics" disabled={!ready || busy || requesting} onClick={() => void start()}>运行离线自检</button>
          {busy && <button data-testid="cancel-job" disabled={snapshot?.job?.state === 'cancelling'} onClick={() => void cancel()}>取消检查</button>}</div>
        {snapshot?.job && <div data-testid="job-status" data-state={snapshot.job.state} className="job" aria-live="polite">
          <div className="job-header"><strong>{labels[snapshot.job.state]}</strong><span>{snapshot.job.progress}%</span></div>
          <progress aria-label="自检进度" value={snapshot.job.progress} max="100" /><p>{snapshot.job.message}</p>
        </div>}
        <details><summary>原生预览引擎</summary><p className="hint">{snapshot?.previewEngine.integrityVerified ? '哈希、Windows x64 架构和握手已验证' : '原生预览完整性/启动尚未通过'}</p><code>{snapshot?.previewEngine.version ?? '尚未就绪'}</code><p className="hint">系统 Media Foundation/WASAPI；不代表已验证硬件解码。Windows N 需要 Media Feature Pack。</p></details>
        <details><summary>导出引擎信息</summary><p className="hint">{snapshot?.engines.integrityVerified ? '二进制完整性检查通过' : '完整性尚未确认'}</p><code>{snapshot?.engines.version ?? '尚未完成校验'}</code></details>
      </details>
      <details data-testid="cleanup-details" className="diagnostics"><summary>缓存恢复记录（{snapshot?.cleanupIssues.length ?? 0}）</summary>
        {!snapshot?.cleanupIssues.length ? <p className="hint">没有待处理的缓存恢复记录。</p> : <>
          <p className="hint">这些条目没有自动删除。已验证的占用/权限问题会在下次启动重试；缺少或损坏标记的历史目录不会被认领。</p>
          <ul>{snapshot.cleanupIssues.map(issue => <li key={`${issue.area}/${issue.directory}`}>
            <code>{issue.area}/{issue.directory}</code><p>{issue.message}。{issue.retryable ? '可在关闭占用程序后重启应用重试。' : '需人工核查，不能补造所有权标记。'}</p>
          </li>)}</ul>
        </>}
        <p className="hint">默认数据目录：%APPDATA%\Motion Photo Studio（测试或部署覆盖时以配置目录为准）。请先核对原片与成品，单独确认目标目录后再处理，不要批量删除。</p>
      </details>
      <p className="hint support-version">版本 {snapshot?.appVersion ?? '0.1.0'} · 全程离线</p>
    </dialog>
  </main>;
}
