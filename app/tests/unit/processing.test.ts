import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessingState, effectiveProcessing, previewCrop, processingGeometry, setProcessingMode, updateProcessingEdits } from '../../src/shared/processing.ts';

const source = { encodedWidth: 3840, encodedHeight: 2160, displayWidth: 2160, displayHeight: 3840 };
test('copy mode parks edits, previews the whole frame and cannot submit suspended filters', () => {
  const crop = { x: 0.1, y: 0.2, width: 0.6, height: 0.5 };
  const settings = { fps: 24, resolution: 720 as const, crf: 18 };
  const edited = createProcessingState({ crop, settings });
  const copy = setProcessingMode(edited, 'copy');
  assert.deepEqual(effectiveProcessing(copy), { mode: 'copy' });
  assert.deepEqual(previewCrop(copy), { x: 0, y: 0, width: 1, height: 1 });
  assert.equal(updateProcessingEdits(copy, { crop: { x: 0, y: 0, width: 1, height: 1 } }), copy);
  assert.deepEqual(processingGeometry(effectiveProcessing(copy), source), { width: 3840, height: 2160,
    displayWidth: 2160, displayHeight: 3840, crop: null, warnings: [] });
  // Caller mutation cannot alter parked state; toggling does not progressively round or reset preferences.
  crop.width = 0.2; settings.crf = 45;
  for (let n = 0, current = copy; n < 100; n++) {
    current = setProcessingMode(setProcessingMode(current, 'encode'), 'copy');
    assert.equal(current.saved, edited.saved);
  }
  const restored = setProcessingMode(copy, 'encode');
  assert.deepEqual(effectiveProcessing(restored), { mode: 'encode', crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 },
    settings: { fps: 24, resolution: 720, crf: 18 } });
  assert.throws(() => { (restored.saved.settings as { crf: number }).crf = 0; }, TypeError);
});
test('normal geometry uses display coordinates, even pixels and never upscales small sources', () => {
  const state = createProcessingState();
  const portrait = processingGeometry(effectiveProcessing(state), source);
  assert.deepEqual([portrait.width, portrait.height], [608, 1080]);
  assert.deepEqual(portrait.crop, { x: 0, y: 0, width: 2160, height: 3840 });
  const small = processingGeometry(effectiveProcessing(state), { encodedWidth: 321, encodedHeight: 241, displayWidth: 321, displayHeight: 241 });
  assert.deepEqual([small.width, small.height], [320, 240]);
  const cropped = updateProcessingEdits(state, { crop: { x: 0.5, y: 0, width: 0.5, height: 0.25 } });
  const geometry = processingGeometry(effectiveProcessing(cropped), source);
  assert.deepEqual(geometry.crop, { x: 1080, y: 0, width: 1080, height: 960 });
  assert.deepEqual([geometry.width, geometry.height], [1080, 960]);
});
test('invalid settings/crops fail explicitly and unrepresentable thin scaled images are not stretched to an arbitrary size', () => {
  assert.throws(() => createProcessingState({ crop: { x: -0.1, y: 0, width: 1, height: 1 }, settings: { fps: 30, resolution: 1080, crf: 23 } }));
  assert.throws(() => updateProcessingEdits(createProcessingState(), { settings: { fps: 0, resolution: 1080, crf: 23 } }));
  const thin = { encodedWidth: 2, encodedHeight: 10000, displayWidth: 2, displayHeight: 10000 };
  assert.throws(() => processingGeometry(effectiveProcessing(createProcessingState()), thin), /偶数尺寸/);
  const original = updateProcessingEdits(createProcessingState(), { settings: { fps: null, resolution: 'original', crf: 23 } });
  assert.deepEqual([processingGeometry(effectiveProcessing(original), thin).width, processingGeometry(effectiveProcessing(original), thin).height], [2, 10000]);
});
