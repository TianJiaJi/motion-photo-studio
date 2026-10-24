import {resolve} from 'node:path';
import {resourceSnapshot,checkPackagedResources} from './lib/package-resources.ts';
if(process.argv.length!==3)throw new Error('Usage: node scripts/check-package-resources.ts <packaged-resources-directory>');
const result=await checkPackagedResources(resolve(process.argv[2]!),await resourceSnapshot(resolve('resources')));
console.log(JSON.stringify(result,null,2));
