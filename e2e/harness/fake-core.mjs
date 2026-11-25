// The Core entry of worker mode: the compiled Core with the fake codec in place of LibreOffice.
import { textSchema } from '@open-docex/shared/text';
import { resolveWorkerConfig } from '../../backend/dist/api/validate-options.js';
import { main } from '../../backend/dist/core/core-entry.js';
import { createFakeCodec } from './fake-codec.mjs';

const codec = createFakeCodec({ textSchema, page: resolveWorkerConfig({}).blankDocument.page });
main({ codec: () => codec });
