/**
 * The only runtime globals `@open-docex/shared` may use (LLD Part 1 §1.4).
 *
 * shared compiles without the DOM lib and without `@types/node`, so any other
 * platform API is a compile error. That enforces isomorphism (HLD §5). Each
 * global below exists in every supported browser and in Node.js >= 22.
 */

interface Crypto {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
}
declare var crypto: Crypto;

interface TextEncoder {
  encode(input?: string): Uint8Array;
}
declare var TextEncoder: {
  prototype: TextEncoder;
  new (): TextEncoder;
};

interface URL {
  readonly protocol: string;
}
declare var URL: {
  prototype: URL;
  new (url: string, base?: string | URL): URL;
};
