import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const SPIKE = fileURLToPath(new URL('..', import.meta.url));
export const WORK = join(SPIKE, '.work');
export const FIXTURES = fileURLToPath(new URL('../../../backend/test/fixtures/text/', import.meta.url));
export const SRC = join(FIXTURES, 'src');
