import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const digest = (b) => createHash("sha256").update(b).digest("hex");
const files = [];
function walk(relative) {
  const full = path.join(root, relative),
    st = fs.lstatSync(full);
  if (st.isSymbolicLink()) throw Error(`source symlink refused: ${relative}`);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(full).sort()) walk(`${relative}/${name}`);
  } else if (st.isFile())
    files.push({
      path: relative,
      bytes: fs.readFileSync(full),
      mode: st.mode & 0o111 ? 0o755 : 0o644,
    });
  else throw Error("source is not regular");
}
for (const p of [
  "src",
  "tests",
  "scripts",
  "fixtures",
  "scenarios",
  ".github",
  "README.md",
  "AGENTS.md",
  "PLAN.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".gitignore",
  "COMPATIBILITY.md",
  "dist/src",
  "npm-shrinkwrap.json",
])
  walk(p);
files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const manifest = files.map((f) => ({
  path: f.path,
  size: f.bytes.length,
  sha256: digest(f.bytes),
  mode: f.mode,
}));
const manifestBytes = Buffer.from(
  JSON.stringify({ schemaVersion: 1, files: manifest }, null, 2) + "\n",
);
const records = [
  ...files,
  { path: "MANIFEST.json", bytes: manifestBytes, mode: 0o644 },
];
const chunks = [];
const put = (b, s, o, n) => b.write(s, o, n, "ascii");
const oct = (n, size) => n.toString(8).padStart(size - 1, "0") + "\0";
for (const f of records) {
  const name = `package/${f.path}`;
  if (Buffer.byteLength(name) > 100) throw Error("USTAR source path too long");
  const h = Buffer.alloc(512);
  put(h, name, 0, 100);
  put(h, oct(f.mode, 8), 100, 8);
  put(h, oct(0, 8), 108, 8);
  put(h, oct(0, 8), 116, 8);
  put(h, oct(f.bytes.length, 12), 124, 12);
  put(h, oct(0, 12), 136, 12);
  h.fill(32, 148, 156);
  h[156] = 48;
  put(h, "ustar\0", 257, 6);
  put(h, "00", 263, 2);
  put(
    h,
    oct(
      h.reduce((a, b) => a + b, 0),
      7,
    ) + " ",
    148,
    8,
  );
  chunks.push(h, f.bytes, Buffer.alloc((512 - (f.bytes.length % 512)) % 512));
}
chunks.push(Buffer.alloc(1024));
const tar = Buffer.concat(chunks);
// Portable gzip/DEFLATE stored blocks. These bytes do not depend on zlib,
// platform timestamps, Git, checkout mtime or runtime compression versions.
const blocks = [Buffer.from([31, 139, 8, 0, 0, 0, 0, 0, 0, 255])];
for (let offset = 0; offset < tar.length; offset += 65535) {
  const size = Math.min(65535, tar.length - offset),
    h = Buffer.alloc(5);
  h[0] = offset + size === tar.length ? 1 : 0;
  h.writeUInt16LE(size, 1);
  h.writeUInt16LE(size ^ 0xffff, 3);
  blocks.push(h, tar.subarray(offset, offset + size));
}
let crc = 0xffffffff;
for (const byte of tar) {
  crc ^= byte;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
}
const footer = Buffer.alloc(8);
footer.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 0);
footer.writeUInt32LE(tar.length >>> 0, 4);
blocks.push(footer);
const archive = Buffer.concat(blocks);
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json")),
).version;
const target = path.resolve(
  process.argv[2] ??
    path.join(
      root,
      "dist",
      `inventory-monitoring-agent-${version}-source.tar.gz`,
    ),
);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, archive);
console.log(
  JSON.stringify({
    path: target,
    files: files.length,
    bytes: archive.length,
    sha256: digest(archive),
  }),
);
