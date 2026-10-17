/** Verify every original archive byte/mode/hash; extraction is deliberately separate. */
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
export const sha = (b) => createHash("sha256").update(b).digest("hex");
export function verifyArchive(file, checkout) {
  const bytes = fs.readFileSync(file),
    tar = gunzipSync(bytes),
    entries = new Map();
  let offset = 0;
  const string = (b, a, n) =>
    b
      .subarray(a, a + n)
      .toString("utf8")
      .split("\0")[0];
  while (offset + 512 <= tar.length) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every((b) => b === 0)) break;
    const name = string(h, 0, 100),
      type = h[156],
      size = parseInt(string(h, 124, 12).trim(), 8),
      mode = parseInt(string(h, 100, 8).trim(), 8);
    if (
      !/^package\/[A-Za-z0-9_.\/-]+$/.test(name) ||
      name.split("/").some((p) => p === ".." || p === ".") ||
      entries.has(name) ||
      type !== 48 ||
      !Number.isSafeInteger(size) ||
      size < 0
    )
      throw Error("nonregular or ambiguous archive member");
    const checksum = parseInt(string(h, 148, 8).trim(), 8),
      copy = Buffer.from(h);
    copy.fill(32, 148, 156);
    if (copy.reduce((a, b) => a + b, 0) !== checksum)
      throw Error("invalid tar checksum");
    if (offset + 512 + size > tar.length) throw Error("truncated member");
    entries.set(name, {
      bytes: tar.subarray(offset + 512, offset + 512 + size),
      mode,
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (tar.length - offset < 1024 || !tar.subarray(offset).every((b) => b === 0))
    throw Error("invalid tar terminator");
  const manifest = JSON.parse(
    entries.get("package/MANIFEST.json")?.bytes.toString() ?? "null",
  );
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.files.length + 1 !== entries.size
  )
    throw Error("manifest member set differs");
  const seen = new Set();
  for (const f of manifest.files) {
    if (seen.has(f.path)) throw Error("duplicate manifest path");
    seen.add(f.path);
    const e = entries.get("package/" + f.path);
    if (
      !e ||
      e.mode !== f.mode ||
      e.bytes.length !== f.size ||
      sha(e.bytes) !== f.sha256
    )
      throw Error("manifest differs: " + f.path);
    if (checkout) {
      const local = path.join(checkout, f.path),
        s = fs.lstatSync(local);
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        (s.mode & 0o111 ? 0o755 : 0o644) !== f.mode ||
        !fs.readFileSync(local).equals(e.bytes)
      )
        throw Error("delivered file changed: " + f.path);
    }
  }
  return {
    files: manifest.files.length,
    bytes: bytes.length,
    sha256: sha(bytes),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(verifyArchive(process.argv[2], process.argv[3])));
