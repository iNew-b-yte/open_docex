import { latencyBench } from './net.mjs';

const mode = process.argv[2] ?? 'main';
const r = await latencyBench(mode, { oneDocClients: [1, 5], manyDocs: [5], rate: 2, warmMs: 1000, measureMs: 3000 });
console.log(JSON.stringify(r, null, 1).slice(0, 3000));
process.exit(0);
