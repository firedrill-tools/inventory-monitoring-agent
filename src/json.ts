import { createHash } from "node:crypto";

export const MAX_BYTES = 8 * 1024 * 1024;
export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function validText(
  value: unknown,
  minimum: number,
  maximum: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value.includes("\0") ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      value,
    )
  )
    throw new Error("bounded original Unicode text required");
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    !Object.is(value, -0)
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object" && value !== null)
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonical((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  throw new Error("complete finite JSON required");
}
export function keys(
  value: unknown,
  expected: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    canonical(Object.keys(value).sort()) !== canonical([...expected].sort())
  )
    throw new Error("original inventory fields differ from declared schema");
}
export function parseJSON(bytes: Uint8Array): unknown {
  if (!bytes.byteLength || bytes.byteLength > MAX_BYTES)
    throw new Error("complete original JSON exceeds bound");
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  let i = 0,
    nodes = 0;
  const ws = () => {
    while (i < text.length && /[ \t\r\n]/.test(text[i])) i++;
  };
  const str = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i++] === '"') {
        const result: unknown = JSON.parse(text.slice(start, i));
        validText(result, 0, MAX_BYTES);
        return result;
      }
    }
    throw new Error("unterminated original JSON string");
  };
  const value = (depth: number): unknown => {
    if (depth > 64 || ++nodes > 200000)
      throw new Error("original JSON depth/node bound exceeded");
    ws();
    if (text[i] === '"') return str();
    if (text[i] === "{") {
      i++;
      ws();
      const result: Record<string, unknown> = Object.create(null);
      if (text[i] === "}") {
        i++;
        return result;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') throw new Error("invalid original JSON key");
        const key = str();
        if (Object.hasOwn(result, key))
          throw new Error("duplicate original JSON key");
        ws();
        if (text[i++] !== ":") throw new Error("invalid original JSON object");
        result[key] = value(depth + 1);
        ws();
        const sep = text[i++];
        if (sep === "}") return result;
        if (sep !== ",") throw new Error("invalid original JSON object");
      }
    }
    if (text[i] === "[") {
      i++;
      ws();
      const result: unknown[] = [];
      if (text[i] === "]") {
        i++;
        return result;
      }
      for (;;) {
        result.push(value(depth + 1));
        ws();
        const sep = text[i++];
        if (sep === "]") return result;
        if (sep !== ",") throw new Error("invalid original JSON array");
      }
    }
    const match =
      /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        text.slice(i),
      );
    if (!match) throw new Error("invalid original JSON value");
    i += match[0].length;
    const result: unknown = JSON.parse(match[0]);
    if (
      typeof result === "number" &&
      (!Number.isFinite(result) || Object.is(result, -0))
    )
      throw new Error("finite original JSON number required");
    return result;
  };
  const result = value(0);
  ws();
  if (i !== text.length) throw new Error("trailing original JSON data");
  return result;
}
