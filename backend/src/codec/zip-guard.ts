/**
 * Zip guard (LLD Part 2 §14.8). Reads only the central directory of an OOXML/ODF package, on
 * the Core thread and before any conversion. Declared sizes can lie; the LibreOffice timeout
 * and kill bound the real cost.
 *
 * @module
 */
import type { FileFormat } from '@open-docex/shared/protocol';
import yauzl from 'yauzl';
import { engineError } from '../errors/engine-error.js';

/** Max entries in a package (§14.8, LLD choice). */
export const MAX_ZIP_ENTRIES = 10_000;
/** Max total declared uncompressed size, as a multiple of `maxFileBytes`. */
export const MAX_TOTAL_RATIO = 20;
/** Max compression ratio of one entry. */
export const MAX_ENTRY_RATIO = 200;

/** What the guard found in an accepted package. */
export interface ZipGuardResult {
  /** A VBA project or `Basic/` folder is present: finding `macros` (PO-13). */
  macros: boolean;
}

const MIMETYPES: Readonly<Record<'odt' | 'ods', string>> = {
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
};

const REQUIRED: Readonly<Record<FileFormat, readonly string[]>> = {
  docx: ['word/document.xml'],
  xlsx: ['xl/workbook.xml'],
  odt: ['mimetype', 'content.xml'],
  ods: ['mimetype', 'content.xml'],
};

const NOT_VALID = 'not a valid or unencrypted file';

function open(buf: Uint8Array): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength), { lazyEntries: true }, (err, zip) => {
      if (err !== null || zip === undefined) {
        reject(engineError('CONVERSION_FAILED', { message: NOT_VALID, cause: err }));
      } else {
        resolve(zip);
      }
    });
  });
}

function readSmall(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err !== null || stream === undefined) {
        reject(engineError('CONVERSION_FAILED', { message: NOT_VALID, cause: err }));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('error', (e: Error) => reject(engineError('CONVERSION_FAILED', { message: NOT_VALID, cause: e })));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

/**
 * Validates `bytes` as a package of `format`. Throws `DOCUMENT_TOO_LARGE` (size, entry count,
 * total size, ratio) or `CONVERSION_FAILED` (not a zip, required part missing).
 */
export async function zipGuard(bytes: Uint8Array, format: FileFormat, maxFileBytes: number): Promise<ZipGuardResult> {
  if (bytes.byteLength > maxFileBytes) {
    throw engineError('DOCUMENT_TOO_LARGE', { message: `File of ${String(bytes.byteLength)} bytes exceeds the limit` });
  }
  const zip = await open(bytes);
  const seen = new Set<string>();
  let macros = false;
  let count = 0;
  let total = 0;
  let mimetype: string | undefined;

  await new Promise<void>((resolve, reject) => {
    const fail = (e: unknown): void => {
      zip.close();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    zip.on('error', (e: Error) => fail(engineError('CONVERSION_FAILED', { message: NOT_VALID, cause: e })));
    zip.on('end', () => resolve());
    zip.on('entry', (entry: yauzl.Entry) => {
      count += 1;
      total += entry.uncompressedSize;
      if (count > MAX_ZIP_ENTRIES) return fail(engineError('DOCUMENT_TOO_LARGE', { message: 'Too many entries' }));
      if (total > MAX_TOTAL_RATIO * maxFileBytes) {
        return fail(engineError('DOCUMENT_TOO_LARGE', { message: 'Uncompressed size too large' }));
      }
      const ratio = entry.compressedSize === 0 ? (entry.uncompressedSize === 0 ? 0 : Infinity) : entry.uncompressedSize / entry.compressedSize;
      if (ratio > MAX_ENTRY_RATIO) return fail(engineError('DOCUMENT_TOO_LARGE', { message: 'Compression ratio too high' }));
      const name = entry.fileName;
      seen.add(name);
      if (name === 'word/vbaProject.bin' || name === 'xl/vbaProject.bin' || name.startsWith('Basic/')) macros = true;
      if (name === 'mimetype' && (format === 'odt' || format === 'ods')) {
        if (entry.uncompressedSize > 256) return fail(engineError('CONVERSION_FAILED', { message: NOT_VALID }));
        readSmall(zip, entry).then(
          (text) => {
            mimetype = text;
            zip.readEntry();
          },
          fail,
        );
        return;
      }
      zip.readEntry();
    });
    zip.readEntry();
  });

  for (const part of REQUIRED[format]) {
    if (!seen.has(part)) throw engineError('CONVERSION_FAILED', { message: `Required part ${part} is missing` });
  }
  if ((format === 'odt' || format === 'ods') && mimetype !== MIMETYPES[format]) {
    throw engineError('CONVERSION_FAILED', { message: 'Wrong mimetype entry' });
  }
  return { macros };
}
