import { fileURLToPath } from 'node:url';
import { verifyEngines } from '../src/main/media/engine.ts';

const resources = fileURLToPath(new URL('../resources/', import.meta.url));
const engines = await verifyEngines(resources);
console.log(`Bundled engines verified: ${engines.build}`);
