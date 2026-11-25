// The Core entry of the integration suite (worker mode, logic flows): the real compiled Core and
// wiring, with the fake text codec of `suite-env.mjs` in place of LibreOffice. Run
// `npm run build` first. The real-LibreOffice tests fork `dist/core/core-entry.js` instead.
import { textSchema } from '@open-docex/shared/text';
import { resolveWorkerConfig } from '../../../dist/api/validate-options.js';
import { main } from '../../../dist/core/core-entry.js';
import { createSuiteCodec } from './suite-env.mjs';

const { ctlDir } = JSON.parse(process.env.ODX_SUITE);
const codec = createSuiteCodec({ textSchema, page: resolveWorkerConfig({}).blankDocument.page, ctlDir });

main({ codec: () => codec });
