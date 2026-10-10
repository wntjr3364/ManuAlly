// A minimal ZIP reader for .docx files (PW-055): the central directory, stored and deflated entries, CRC
// checks. Defensive by design — a .docx comes from outside: no ZIP64, no encrypted entries, a cap on the
// number of entries and on the declared unpacked size (ZIP bombs), and an entry is never unpacked beyond
// the size it declares. Only the parts asked for are unpacked; nothing is written to disk.
import { crc32, inflateRawSync } from 'node:zlib';

export type ZipFailure = 'NOT_ZIP' | 'ENCRYPTED' | 'TOO_LARGE' | 'CORRUPT';
export class ZipError extends Error {
  readonly reason: ZipFailure;
  constructor(message: string, reason: ZipFailure) {
    super(message);
    this.reason = reason;
  }
}

export const ZIP_LIMITS = { entries: 2000, totalUnpacked: 50 * 1024 * 1024 };
interface Entry { name: string; method: number; crc: number; packed: number; unpacked: number; offset: number }

export interface Zip { names: string[]; read(name: string): Buffer | null }

export function openZip(buf: Buffer): Zip {
  // the end of central directory record: within the last 64 KiB + 22 bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('not a ZIP file', 'NOT_ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported', 'CORRUPT');
  if (count > ZIP_LIMITS.entries) throw new ZipError(`more than ${ZIP_LIMITS.entries} parts`, 'TOO_LARGE');
  if (cdOffset + cdSize > eocd) throw new ZipError('the central directory is outside the file', 'CORRUPT');
  const entries = new Map<string, Entry>();
  let total = 0;
  let at = cdOffset;
  for (let k = 0; k < count; k++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new ZipError('a damaged central directory', 'CORRUPT');
    const flags = buf.readUInt16LE(at + 8);
    const e: Entry = {
      method: buf.readUInt16LE(at + 10), crc: buf.readUInt32LE(at + 16), packed: buf.readUInt32LE(at + 20), unpacked: buf.readUInt32LE(at + 24),
      offset: buf.readUInt32LE(at + 42), name: '',
    };
    const nameLen = buf.readUInt16LE(at + 28);
    e.name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    if (flags & 1) throw new ZipError('the file is password-protected (encrypted); save it without a password and import again', 'ENCRYPTED');
    if (e.packed === 0xffffffff || e.unpacked === 0xffffffff || e.offset === 0xffffffff) throw new ZipError('ZIP64 parts are not supported', 'CORRUPT');
    total += e.unpacked;
    if (total > ZIP_LIMITS.totalUnpacked) throw new ZipError(`unpacked, the file would be larger than ${ZIP_LIMITS.totalUnpacked} bytes`, 'TOO_LARGE');
    entries.set(e.name, e);
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new ZipError(`a damaged part: ${name}`, 'CORRUPT');
      const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
      const packed = buf.subarray(start, start + e.packed);
      if (packed.length !== e.packed) throw new ZipError(`a truncated part: ${name}`, 'CORRUPT');
      let out: Buffer;
      try {
        if (e.method === 0) out = Buffer.from(packed);
        else if (e.method === 8) out = inflateRawSync(packed, { maxOutputLength: Math.max(1, e.unpacked) });
        else throw new ZipError(`an unsupported compression in ${name}`, 'CORRUPT');
      } catch (err) {
        if (err instanceof ZipError) throw err;
        throw new ZipError(`a part does not unpack to its declared size: ${name}`, 'CORRUPT');
      }
      if (out.length !== e.unpacked || crc32(out) !== e.crc) throw new ZipError(`a part does not match its declared size or checksum: ${name}`, 'CORRUPT');
      return out;
    },
  };
}
