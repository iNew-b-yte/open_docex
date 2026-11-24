/**
 * The codec worker-thread entry (LLD Part 2 §14.1, §0 S-43). `CodecPool` starts this file as a
 * `Worker`; it installs the real {@link FodtMapper} and listens for jobs. Nothing else runs here.
 *
 * @module
 */
import { startCodecThread } from './codec-thread.js';
import { FodtMapper } from './fodt-mapper.js';

startCodecThread(new FodtMapper());
