import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centeredAspectCrop, clipSelectionWithDuration, cropToPixels, parseClipDurationSeconds } from '../../src/shared/editor.ts';

test('custom duration parses decimal seconds exactly and rejects invalid values', () => {
  for (const [input, expected] of [['3',3000000],['5',5000000],['2.5',2500000],['.125',125000],['0.001',1000],[' 01.010 ',1010000],['5.',5000000]] as const)
    assert.equal(parseClipDurationSeconds(input),expected);
  for (const input of ['', ' ', '0', '0.000', '-2', 'abc', '1e3', '0.0001', 'Infinity', '3,5', '9007199254.741', '1'.repeat(40)])
    assert.equal(parseClipDurationSeconds(input),null,input);
  assert.equal(parseClipDurationSeconds('9007199254.740'),9007199254740000);
  const original={startUs:4000000,endUs:7000000};
  assert.deepEqual(clipSelectionWithDuration(original,12000000,parseClipDurationSeconds('2.5')!),{startUs:4000000,endUs:6500000});
  assert.deepEqual(clipSelectionWithDuration(original,12000000,parseClipDurationSeconds('5')!),{startUs:4000000,endUs:9000000});
});

test('aspect presets center within landscape, portrait and rotated display geometry', () => {
  for (const [width,height] of [[1920,1080],[1080,1920],[320,240],[240,320]]) {
    for (const ratio of [1,4/5,9/16,16/9]) {
      const crop=centeredAspectCrop(width!,height!,ratio);
      assert.ok(crop.x>=0 && crop.y>=0 && crop.width>0 && crop.height>0);
      assert.ok(crop.x+crop.width<=1 && crop.y+crop.height<=1);
      assert.ok(Math.abs(crop.x*2+crop.width-1)<1e-12);
      assert.ok(Math.abs(crop.y*2+crop.height-1)<1e-12);
      assert.ok(Math.abs(crop.width*width!/(crop.height*height!)-ratio)<1e-12);
      const pixels=cropToPixels(crop,width!,height!);
      assert.equal(pixels.width%2,0);assert.equal(pixels.height%2,0);
    }
  }
  for(const ratio of [0,-1,NaN,Infinity])assert.throws(()=>centeredAspectCrop(320,180,ratio));
  for(const width of [0,1,2.5,Infinity])assert.throws(()=>centeredAspectCrop(width,180,1));
});
test('uniform duration anchors each in-point, extends or trims the out-point and preserves short EOF tails', () => {
  const clips=[{startUs:0,endUs:10_000_000},{startUs:2_000_000,endUs:2_500_000},{startUs:9_000_000,endUs:10_000_000}];
  const original=structuredClone(clips);
  assert.deepEqual(clips.map(clip=>clipSelectionWithDuration(clip,10_000_000,3_000_000)),[
    {startUs:0,endUs:3_000_000},{startUs:2_000_000,endUs:5_000_000},{startUs:9_000_000,endUs:10_000_000},
  ]);
  assert.deepEqual(clips,original);
  assert.deepEqual(clipSelectionWithDuration({startUs:0,endUs:2},2,3_000_000),{startUs:0,endUs:2});
  const end=Number.MAX_SAFE_INTEGER;
  assert.deepEqual(clipSelectionWithDuration({startUs:end-1,endUs:end},end,3_000_000),{startUs:end-1,endUs:end});
});
test('uniform duration rejects invalid selections and lengths without shifting boundaries', () => {
  for(const length of [0,-1,0.5,NaN,Infinity])assert.throws(()=>clipSelectionWithDuration({startUs:0,endUs:5},10,length));
  assert.throws(()=>clipSelectionWithDuration({startUs:10,endUs:10},10,3));
  assert.throws(()=>clipSelectionWithDuration({startUs:2,endUs:11},10,3));
});
