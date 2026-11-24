import { inflateRawSync } from "node:zlib";

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;

/**
 * Central directory entries of a ZIP. `buf` may be just the tail of the archive: `base` is the
 * absolute offset of buf[0]. Returns null when the directory is not entirely inside `buf` or is ZIP64.
 */
export function centralDirectory(buf, base = 0) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > buf.length) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff || offset < base) return null;
  let ptr = offset - base;
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CENTRAL) throw new Error("Directory ZIP illeggibile");
    const nameLen = buf.readUInt16LE(ptr + 28);
    entries.push({
      name: buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8"),
      method: buf.readUInt16LE(ptr + 10),
      crc: buf.readUInt32LE(ptr + 16),
      compSize: buf.readUInt32LE(ptr + 20),
      size: buf.readUInt32LE(ptr + 24),
      localOff: buf.readUInt32LE(ptr + 42),
    });
    ptr += 46 + nameLen + buf.readUInt16LE(ptr + 30) + buf.readUInt16LE(ptr + 32);
  }
  return entries;
}

/** Read selected files from a ZIP buffer. Skips everything else; only `optional` names may be missing. */
export function readZip(buf, wanted, optional = new Set()) {
  const entries = centralDirectory(buf);
  if (!entries) throw new Error("ZIP senza directory centrale");
  const files = new Map();
  for (const { name, method, compSize, localOff } of entries) {
    const base = name.split("/").pop();
    if (!wanted.has(base)) continue;
    if (buf.readUInt32LE(localOff) !== LOCAL) throw new Error(`Header locale assente per ${base}`);
    const localName = buf.readUInt16LE(localOff + 26);
    const localExtra = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + localName + localExtra;
    const comp = buf.subarray(start, start + compSize);
    const data = method === 0 ? comp : method === 8 ? inflateRawSync(comp) : null;
    if (!data) throw new Error(`Metodo ZIP ${method} non gestito`);
    files.set(base, data);
  }
  for (const name of wanted) {
    if (!files.has(name) && !optional.has(name)) throw new Error(`Manca ${name} nel GTFS`);
  }
  return files;
}
