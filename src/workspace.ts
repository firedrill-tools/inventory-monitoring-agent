/** Sequential trusted synthetic-human source; normal managed tools are separate. */
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  effective,
  eligible,
  identifier,
  type Action,
  type InventoryEvent,
} from "./domain.js";
import { canonical, MAX_BYTES, parseJSON } from "./json.js";
import {
  humanTransition,
  validateState,
  type InventoryState,
} from "./schema.js";
export type { Item, InventoryEvent } from "./domain.js";
export type { InventoryState } from "./schema.js";

const identity = (s: { dev: bigint; ino: bigint }) => `${s.dev}:${s.ino}`;
export function readRegular(file: string) {
  const first = lstatSync(file, { bigint: true });
  if (
    !first.isFile() ||
    first.nlink !== 1n ||
    first.size <= 0n ||
    first.size > BigInt(MAX_BYTES)
  )
    throw new Error(
      "bounded regular unshared nonsymlink inventory source required",
    );
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true }),
      raw = readFileSync(fd),
      after = fstatSync(fd, { bigint: true }),
      current = lstatSync(file, { bigint: true });
    if (
      identity(first) !== identity(before) ||
      identity(current) !== identity(before) ||
      before.nlink !== 1n ||
      current.nlink !== 1n ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      raw.length !== Number(before.size) ||
      raw.length > MAX_BYTES
    )
      throw new Error("original inventory source changed while reading");
    return {
      raw,
      identity: identity(before),
    };
  } finally {
    closeSync(fd);
  }
}
export function readOriginal(file: string) {
  const original = readRegular(file);
  return { ...original, state: validateState(parseJSON(original.raw)) };
}
export function loadState(file: string): InventoryState {
  return readOriginal(resolve(file)).state;
}
export class Workspace {
  readonly file: string;
  private parentIdentity: string;
  private fileIdentity = "";
  private original = Buffer.alloc(0);
  private guardFd: number | null = null;
  private closeAttempted = false;
  constructor(file: string) {
    const supplied = resolve(file);
    this.file = join(realpathSync(dirname(supplied)), basename(supplied));
    this.parentIdentity = identity(
      lstatSync(dirname(this.file), { bigint: true }),
    );
    const first = readOriginal(this.file);
    this.fileIdentity = first.identity;
    this.original = first.raw;
    this.guardFd = openSync(
      this.file,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      this.guard();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private guard() {
    if (this.closeAttempted || this.guardFd === null)
      throw new Error("inventory source guard is closed");
    const pinned = fstatSync(this.guardFd, { bigint: true });
    if (
      pinned.nlink !== 1n ||
      identity(pinned) !== this.fileIdentity ||
      identity(lstatSync(this.file, { bigint: true })) !== this.fileIdentity ||
      identity(lstatSync(dirname(this.file), { bigint: true })) !==
        this.parentIdentity
    )
      throw new Error("original inventory file/root identity changed");
  }
  close() {
    if (this.closeAttempted)
      throw new Error("inventory source close already attempted");
    this.closeAttempted = true;
    const fd = this.guardFd;
    this.guardFd = null;
    if (fd !== null) closeSync(fd);
  }
  read() {
    this.guard();
    const fresh = readOriginal(this.file);
    this.guard();
    if (fresh.identity !== this.fileIdentity)
      throw new Error("original inventory source identity changed");
    this.original = fresh.raw;
    return fresh.state;
  }
  save(data: InventoryState) {
    this.guard();
    validateState(data);
    const current = readOriginal(this.file);
    if (
      current.identity !== this.fileIdentity ||
      !current.raw.equals(this.original)
    )
      throw new Error("original inventory source changed before save");
    if (canonical(current.state) === canonical(data)) return false;
    const raw = Buffer.from(JSON.stringify(data, null, 2) + "\n");
    if (raw.length > MAX_BYTES)
      throw new Error("complete inventory source exceeds bound");
    const temporary = join(
      dirname(this.file),
      ".inventory-" + randomUUID() + ".tmp",
    );
    try {
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        writeFileSync(fd, raw);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.guard();
      const fresh = readOriginal(this.file);
      if (fresh.identity !== current.identity || !fresh.raw.equals(current.raw))
        throw new Error("original inventory source changed during staging");
      renameSync(temporary, this.file);
      const directory = openSync(dirname(this.file), constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      const replacement = readOriginal(this.file);
      const next = openSync(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const previous = this.guardFd!;
      this.guardFd = next;
      this.fileIdentity = replacement.identity;
      this.original = replacement.raw;
      closeSync(previous);
      this.guard();
      return true;
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  inspect(sku?: string) {
    if (sku !== undefined) identifier(sku);
    const data = this.read();
    return {
      items: data.items
        .filter((r) => sku === undefined || r.sku === sku)
        .map((r) => ({ ...r, effective: effective(r), eligible: eligible(r) })),
      alerts: data.alerts.filter((r) => sku === undefined || r.sku === sku),
      drafts: data.drafts.filter((r) => sku === undefined || r.sku === sku),
    };
  }
  private apply(action: Action) {
    const data = this.read();
    const next = humanTransition(data, this.original, action);
    if (next.changed) this.save(next.state);
    return next.result;
  }
  applyEvent(event: InventoryEvent) {
    return this.apply({ kind: "event", args: event });
  }
  evaluate(sku: string) {
    return this.apply({ kind: "evaluate", args: { sku } });
  }
  prepare(sku: string, expectedRevision: number) {
    return this.apply({ kind: "prepare", args: { sku, expectedRevision } });
  }
}
