import type { ReactNode } from 'react';
import './import-welcome.css';

export function ImportWelcome({ action, phase, error, notice }: {
  action: ReactNode; phase: 'idle' | 'choosing' | 'reading'; error: string; notice: string;
}) {
  return <section className="import-welcome" data-testid="import-welcome" data-phase={phase} aria-labelledby="import-heading">
    <div className="import-hero">
      <div className="import-copy">
        <span className="import-eyebrow">MOTION PHOTO STUDIO</span>
        <h2 id="import-heading">让这一刻，<br /><span>动起来。</span></h2>
        <p className="import-intro">把喜欢的一段视频，<br />变成一张有声音、有故事的实况照片。</p>
        <div className="import-action">{action}</div>
        <p className="import-formats">MP4 / MOV 等本地视频</p>
        <div className="import-feedback" role="status" aria-live="polite" aria-atomic="true">
          {phase === 'choosing' && <p>请在系统窗口中选择视频</p>}
          {phase === 'reading' && <p><span className="import-spinner" aria-hidden="true" />正在读取视频信息，马上进入编辑…</p>}
          {phase === 'idle' && notice && <p>{notice}</p>}
        </div>
        {error && <div className="import-error error" role="alert"><strong>没能打开这个视频</strong><p>{error}</p></div>}
      </div>
      <div className="import-art" aria-hidden="true">
        <div className="import-orbit" />
        <div className="import-photo-back" />
        <div className="import-photo">
          <div className="import-photo-scene">
            <svg viewBox="0 0 300 360" preserveAspectRatio="xMidYMid slice" focusable="false">
              <defs>
                <linearGradient id="welcome-sky" x2="0" y2="1"><stop stopColor="#243f47"/><stop offset=".65" stopColor="#8aada5"/><stop offset="1" stopColor="#d6c5a5"/></linearGradient>
                <linearGradient id="welcome-water" x2="0" y2="1"><stop stopColor="#648f89"/><stop offset="1" stopColor="#1d4147"/></linearGradient>
                <linearGradient id="welcome-shore" x2="1" y2="1"><stop stopColor="#23474c"/><stop offset="1" stopColor="#102c33"/></linearGradient>
              </defs>
              <path fill="url(#welcome-sky)" d="M0 0h300v360H0z"/>
              <circle cx="216" cy="106" r="27" fill="#f2dbad" opacity=".9"/>
              <path d="m0 195 55-58 42 34 62-60 78 71 35-24 28 20v182H0Z" fill="#587d7a"/>
              <path d="m0 207 63-31 54 35 66-46 72 35 45-10v170H0Z" fill="#3a6669"/>
              <path d="M0 222q90-15 155-6t145-3v147H0Z" fill="url(#welcome-water)"/>
              <g fill="none" stroke="#c0d4bf" strokeLinecap="round" opacity=".32"><path d="M178 237h65m-81 11h70m-89 14h107m-124 14h94m-122 17h139m-159 19h122"/></g>
              <path d="M0 243q81 10 103 51t130 66H0Z" fill="url(#welcome-shore)"/>
              <path d="M0 250q79 7 97 47t114 63" fill="none" stroke="#aec7b7" strokeWidth="2" opacity=".5"/>
              <path d="m71 94 7-3 7 3m8-10 6-2 6 2" fill="none" stroke="#d9e5d8" strokeWidth="1.5" opacity=".65"/>
            </svg>
            <span className="import-live-mark"><span /> LIVE</span>
            <div className="import-photo-motion"><span /><span /><span /><span /><span /><span /><span /></div>
          </div>
          <div className="import-photo-caption"><span>留住风景，也留住风声</span><span>01</span></div>
        </div>
        <span className="import-art-note">不止一张照片</span>
      </div>
    </div>
    <ol className="import-steps" aria-label="制作步骤">
      <li><span>01</span><div><strong>选一段视频</strong><p>从本地开始</p></div></li>
      <li><span>02</span><div><strong>定格你的瞬间</strong><p>选片段，挑封面</p></div></li>
      <li><span>03</span><div><strong>保存为实况照片</strong><p>一段，或多段一起</p></div></li>
    </ol>
    <p className="import-privacy"><svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="4" y="8" width="12" height="9" rx="2"/><path d="M6 8V6a4 4 0 0 1 8 0v2"/></svg>全程本地处理 · 不上传素材 · 不修改原片</p>
  </section>;
}
