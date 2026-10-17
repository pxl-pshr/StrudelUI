// Zip files: writes uncompressed zips (stems, tunes with their samples);
// reads stored and deflated entries, so a zip re-made by the OS or another
// tool opens too. No zip64: up to 4 GB.

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// MS-DOS time and date, as zip stores them
function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

const UTF8 = 0x0800; // general purpose flag: names are UTF-8

export async function zip(files /* [{ name, blob }] */) {
  const total = files.reduce((n, f) => n + f.blob.size + 76 + 2 * f.name.length, 22);
  if (total >= 2 ** 32) throw new Error('over 4 GB is too big for a zip here: export fewer bars or tracks');
  const [time, date] = dosTime();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = new TextEncoder().encode(f.name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(local, name, data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, UTF8, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(dir, name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

// [{ path, blob }] for every file in the zip (folders and macOS metadata left
// out). Throws on anything that isn't a zip it can read.
export async function unzip(blob) {
  const buf = await blob.arrayBuffer();
  const v = new DataView(buf);
  // end of central directory: 22 bytes, plus a comment of up to 64 KB
  let end = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error("not a zip file");
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error('damaged zip file');
    const method = v.getUint16(at + 10, true);
    const packed = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const skip = nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const path = new TextDecoder().decode(new Uint8Array(buf, at + 46, nameLen));
    at += 46 + skip;
    if (packed === 0xffffffff) throw new Error('zip64 files are not supported');
    if (path.endsWith('/') || path.startsWith('__MACOSX/') || /(^|\/)(\._|\.DS_Store$)/.test(path)) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = new Blob([new Uint8Array(buf, start, packed)]);
    if (method === 0) out.push({ path, blob: data });
    else if (method === 8) {
      const inflated = await new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      out.push({ path, blob: inflated });
    } else throw new Error(`${path}: compression method ${method} is not supported`);
  }
  return out;
}
