import { readFile, writeFile } from 'node:fs/promises';

const input = process.argv[2];
const output = process.argv[3];

if (!input || !output) {
  throw new Error('usage: node scripts/png-to-ico.mjs input.png output.ico');
}

const png = await readFile(input);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);

const directory = Buffer.alloc(16);
directory.writeUInt8(0, 0);
directory.writeUInt8(0, 1);
directory.writeUInt8(0, 2);
directory.writeUInt8(0, 3);
directory.writeUInt16LE(1, 4);
directory.writeUInt16LE(32, 6);
directory.writeUInt32LE(png.length, 8);
directory.writeUInt32LE(header.length + directory.length, 12);

await writeFile(output, Buffer.concat([header, directory, png]));
