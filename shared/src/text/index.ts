/**
 * `@open-docex/shared/text`: the text document model (LLD Part 1 §8): schema, link
 * allowlist, page settings, ops, chunking, rebase, apply-with-drop and `TextOtType`.
 */
export { textSchema } from './schema.js';
export type { LineHeight, TextAlign, TextDefaults, TextMarkName, TextNodeName, TextSnapshot } from './schema.js';
export { isAllowedHref } from './href.js';
export { getPageSettings, pageSettingStep } from './page.js';
export type { PageSettings } from './page.js';
export { parseTextOps } from './steps.js';
export type { TextOp, TextStepType } from './steps.js';
export { assembleText, chunkText } from './chunk.js';
export type { TextChunkData, TextRegion } from './chunk.js';
export { rebaseSteps, rebaseStepsOnDoc } from './rebase.js';
export { applyStepsWithDrop } from './apply.js';
export { textOpsEqual } from './equal.js';
export { TextOtType } from './ot.js';
