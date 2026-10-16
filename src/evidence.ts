import {
  mkdirSync,
  openSync,
  writeFileSync,
  closeSync,
  fsyncSync,
  renameSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { digest, type Snapshot } from "./managed-state.js";
import { randomUUID, createHash } from "node:crypto";
export const sha256 = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
export const errorInfo = (v: unknown) => {
  const chain: { name: string; message: string }[] = [];
  const seen = new Set<unknown>();
  let current = v;
  while (current && !seen.has(current) && chain.length < 8) {
    seen.add(current);
    chain.push({
      name: current instanceof Error ? current.name : "Error",
      message: current instanceof Error ? current.message : String(current),
    });
    current = current instanceof Error ? current.cause : null;
  }
  return chain;
};
export type Measurement =
  | { status: "observed"; value: number }
  | { status: "unknown" | "invalid"; value: null };
export function counter(usage: unknown, name: string): Measurement {
  if (!usage || typeof usage !== "object" || !Object.hasOwn(usage, name))
    return { status: "unknown", value: null };
  const v: unknown = Reflect.get(usage, name);
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    ? { status: "observed", value: v }
    : { status: "invalid", value: null };
}
export function usageOf(body: unknown) {
  const usage =
    body && typeof body === "object"
      ? Reflect.get(body, "usageMetadata")
      : null;
  return {
    input: counter(usage, "promptTokenCount"),
    output: counter(usage, "candidatesTokenCount"),
    total: counter(usage, "totalTokenCount"),
    cachedInput: counter(usage, "cachedContentTokenCount"),
    reasoningOutput: counter(usage, "thoughtsTokenCount"),
  };
}
export function summarize(
  calls: { reportedUsage?: ReturnType<typeof usageOf> }[],
) {
  const result: Record<string, unknown> = {};
  for (const key of [
    "input",
    "output",
    "total",
    "cachedInput",
    "reasoningOutput",
  ] as const) {
    const rows = calls.map(
      (c) => c.reportedUsage?.[key] ?? { status: "unknown", value: null },
    );
    const values = rows
      .filter((x) => x.status === "observed")
      .map((x) => x.value!);
    const subtotal = values.reduce((a, b) => a + BigInt(b), 0n);
    const safe = subtotal <= BigInt(Number.MAX_SAFE_INTEGER);
    result[key] = {
      value:
        rows.length && values.length === rows.length && safe
          ? Number(subtotal)
          : null,
      knownSubtotal: safe ? Number(subtotal) : null,
      observed: values.length,
      unknown: rows.filter((x) => x.status === "unknown").length,
      invalid: rows.filter((x) => x.status === "invalid").length,
      complete: rows.length > 0 && values.length === rows.length && safe,
    };
  }
  return {
    source: "original Gemini JSON counters; no estimation or billing proof",
    preparedAttempts: calls.length,
    ...result,
    costUsd: null,
  };
}

export class Receipt {
  readonly path: string;
  readonly data: Record<string, any>;
  recordingError: unknown;
  constructor(outputRoot: string, initial: Record<string, unknown>) {
    const root = resolve(outputRoot);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
      throw new Error("invalid receipt root");
    const runId = randomUUID(),
      dir = join(root, runId);
    mkdirSync(dir, { mode: 0o700 });
    this.path = join(dir, "receipt.json");
    this.data = {
      schemaVersion: 2,
      sourceImages: {},
      sourceBlobs: {},
      sdk: [],
      acknowledgedEffects: [],
      acknowledgedDecisions: [],
      runId,
      receiptPath: this.path,
      status: "prepared",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      calls: [],
      actions: [],
      result: null,
      error: null,
      cleanupConfirmed: false,
      ...structuredClone(initial),
    };
    this.save();
  }
  source(snapshot: Snapshot) {
    const original = snapshot.original;
    if (!this.data.sourceImages[snapshot.sha256]) {
      const blob = (value: unknown) => {
        const sha = digest(value);
        this.data.sourceBlobs[sha] ??= structuredClone(value);
        return sha;
      };
      this.data.sourceImages[snapshot.sha256] = {
        schemaRef: blob(original.schema),
        sourceDocumentRef: blob(original.sourceDocument),
        tableRefs: Object.fromEntries(
          Object.entries(original.tables).map(([name, rows]) => [
            name,
            rows.map(blob),
          ]),
        ),
        contextSha256: snapshot.contextSha256,
      };
    }
    return { sha256: snapshot.sha256, contextSha256: snapshot.contextSha256 };
  }
  save() {
    if (this.recordingError) throw this.recordingError;
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try {
        const raw = Buffer.from(JSON.stringify(this.data, null, 2) + "\n");
        if (raw.length > 64 * 1024 * 1024)
          throw new Error("complete private receipt exceeds64MiB");
        writeFileSync(fd, raw);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
      const fd2 = openSync(resolve(this.path, ".."), "r");
      try {
        fsyncSync(fd2);
      } finally {
        closeSync(fd2);
      }
    } catch (e) {
      this.recordingError = e;
      this.data.recordingFailed = true;
      this.data.durableStatus = "unknown";
      if (e instanceof Error)
        try {
          Object.assign(e, { receipt: this });
        } catch {}
      throw e;
    } finally {
      rmSync(temp, { force: true });
    }
  }
}

export function expandSource(
  data: Record<string, any>,
  ref: { sha256: string; contextSha256: string },
) {
  const image = data.sourceImages[ref.sha256];
  if (!image || image.contextSha256 !== ref.contextSha256)
    throw new Error("original source image reference differs");
  const get = (sha: string) => {
    const value = data.sourceBlobs[sha];
    if (value === undefined || digest(value) !== sha)
      throw new Error("original source blob differs");
    return structuredClone(value);
  };
  const original = {
    schema: get(image.schemaRef),
    sourceDocument: get(image.sourceDocumentRef),
    tables: Object.fromEntries(
      Object.entries(image.tableRefs as Record<string, string[]>).map(
        ([name, rows]) => [name, rows.map(get)],
      ),
    ),
  };
  if (digest(original) !== ref.sha256)
    throw new Error("complete original source image hash differs");
  return original;
}

export function bytesImage(
  raw: Buffer,
  complete = true,
  observedBytes = raw.length,
) {
  return {
    base64: raw.toString("base64"),
    sha256: sha256(raw),
    bytes: raw.length,
    observedBytes,
    complete,
    truncated: observedBytes > raw.length,
  };
}
