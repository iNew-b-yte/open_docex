/**
 * `@open-docex/shared/protocol`: every WebSocket message, binary framing, validation,
 * encode/decode and close codes (HLD §9, LLD Part 1 §5, §6).
 *
 * Transport and session logic belong to the server and the client.
 *
 * @module
 */
export * from './messages.js';
export { encodeMessage, decodeClientMessage, decodeServerMessage, isBinaryType, type DecodeResult } from './codec.js';
export { CloseCode, closeCodeFor } from './close-codes.js';
