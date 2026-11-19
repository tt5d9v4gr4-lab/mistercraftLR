'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** Минимальный распаковщик zip/jar (без внешних зависимостей). */
function extractZip(zipPath, dest, filter) {
  const buf = fs.readFileSync(zipPath);
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error('Некорректный zip-файл: ' + zipPath);
  const count = buf.readUInt16LE(i + 10);
  let off = buf.readUInt32LE(i + 16);
  const base = path.resolve(dest);
  fs.mkdirSync(base, { recursive: true });

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Повреждён каталог zip');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    off += 46 + nlen + elen + clen;

    if (name.endsWith('/')) {
      const dir = path.resolve(base, name);
      if (dir.startsWith(base)) fs.mkdirSync(dir, { recursive: true });
      continue;
    }
    if (filter && !filter(name)) continue;
    const target = path.resolve(base, name);
    if (!target.startsWith(base + path.sep)) continue; // защита от zip-slip

    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const data = buf.subarray(start, start + csize);
    let out;
    if (method === 0) out = data;
    else if (method === 8) out = zlib.inflateRawSync(data);
    else throw new Error('Неподдерживаемый метод сжатия zip: ' + method);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, out);
  }
}

module.exports = { extractZip };
