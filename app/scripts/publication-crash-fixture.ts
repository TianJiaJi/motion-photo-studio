// Integration-only crash checkpoint. Not included in desktop packages and not a product entry point.
import { isAbsolute } from 'node:path';
import { Publications } from '../src/main/jobs/publications.ts';
import { openSource } from '../src/main/media/source.ts';
import { publishMotionPhoto } from '../src/main/motion/publish.ts';
const [root, coverPath, videoPath, output, phase] = process.argv.slice(2);
if (!root || !coverPath || !videoPath || !output || ![root, coverPath, videoPath, output].every(isAbsolute)
  || !['before', 'after'].includes(phase ?? '') || !process.send) throw new Error('Invalid integration checkpoint invocation');
process.on('message', () => {}); // Keep the IPC channel referenced while a deliberate checkpoint is held.
process.on('disconnect', () => process.exit(2));
const hold = () => new Promise<never>(() => {});
let committed = false;
class CrashJournal extends Publications {
  override async cleanup(id: string): Promise<void> {
    if (phase === 'after' && committed) { process.send!({ phase: 'after' }); await hold(); }
    await super.cleanup(id);
  }
}
try {
  const journal = new CrashJournal(root); await journal.initialize();
  await publishMotionPhoto({ cover: await openSource(coverPath), video: await openSource(videoPath), output, timestampUs: 0,
    videoDurationUs: 3000000, journal, signal: new AbortController().signal,
    onCommitted: () => { committed = true; },
    onStage: async (stage, written) => {
      if (phase === 'before' && stage === 'mux' && written !== undefined && written > 0) {
        process.send!({ phase: 'before' }); await hold();
      }
    } });
  throw new Error('Checkpoint was not reached');
} catch (error) {
  process.send?.({ phase: 'error', message: String(error) }); process.exitCode = 1; process.disconnect?.();
}
