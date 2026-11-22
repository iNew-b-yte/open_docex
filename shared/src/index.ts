/**
 * `@open-docex/shared`: isomorphic contracts used by `@open-docex/server` and
 * `@open-docex/client` (LLD Part 1 §2). It runs in browsers and in Node.js, so it
 * uses no Node or DOM APIs beyond those declared in `env.d.ts`.
 *
 * The root re-exports every public module (LLD Part 1 §2). Main-process code imports only
 * the `/protocol`, `/errors` and `/ids` subpaths (N4). Modules not yet implemented
 * (`/protocol`, `/ot`, `/text`, `/sheet`) are added by later tasks.
 */
export * from './util/index.js';
export * from './ids/index.js';
export * from './errors/index.js';
