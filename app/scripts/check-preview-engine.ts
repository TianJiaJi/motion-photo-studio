import {fileURLToPath} from 'node:url';
import {verifyNativeEngine} from '../src/main/media/native-engine.ts';
const resources=fileURLToPath(new URL('../resources/',import.meta.url));
const engine=await verifyNativeEngine(resources);
console.log(`Bundled native preview verified: ${engine.version}`);
