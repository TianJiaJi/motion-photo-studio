import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { audioEndpointAvailable } from '../helpers.ts';

// Playback drives the actual WASAPI device clock. Hosts with no audio render endpoint
// (e.g. CI runners) cannot validate audible playback; those tests skip explicitly there
// and must still fail for real audio errors wherever an endpoint exists.
const helper = resolve('resources/bin/motion-preview.exe');
export async function playbackNeedsAudioEndpoint(): Promise<void> {
  if (!(await audioEndpointAvailable(helper))) {
    test.skip(true, '此主机没有音频输出端点，实际 WASAPI 播放须在有音频设备的主机验证');
  }
}
