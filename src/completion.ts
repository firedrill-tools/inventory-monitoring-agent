/** Whole original Gemini JSON is checked before the actual SDK receives it. */
import { identifier, integer } from "./domain.js";
import { keys, parseJSON, validText } from "./json.js";

export const TOOL_NAMES = [
  "inspectInventory",
  "evaluateInventory",
  "prepareReplenishment",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export type NativeAction = { name: ToolName; args: Record<string, unknown> };
export type Completion =
  | {
      kind: "tool";
      action: NativeAction;
      nativeFunctionId: string | null;
      text: string;
      responseId: string;
      reportedModel: string;
    }
  | { kind: "text"; text: string; responseId: string; reportedModel: string };
export function toolArguments(name: unknown, args: unknown): NativeAction {
  if (!TOOL_NAMES.includes(name as ToolName))
    throw new Error("unknown original native inventory function");
  if (name === "inspectInventory") {
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new Error("exact original inspect arguments required");
    const expected = Object.hasOwn(args, "sku") ? ["sku"] : [];
    keys(args, expected);
    if (expected.length) identifier(args.sku);
  } else if (name === "evaluateInventory") {
    keys(args, ["sku"]);
    identifier(args.sku);
  } else {
    keys(args, ["sku", "expectedRevision"]);
    identifier(args.sku);
    integer(args.expectedRevision, 1);
  }
  return {
    name: name as ToolName,
    args: structuredClone(args as Record<string, unknown>),
  };
}
export function completed(raw: Buffer): {
  body: Record<string, any>;
  completion: Completion;
} {
  if (raw.length > 1024 * 1024)
    throw new Error("original Gemini response exceeds1MiB");
  const body = parseJSON(raw) as Record<string, any>;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.hasOwn(body, "error") ||
    !Array.isArray(body.candidates) ||
    body.candidates.length !== 1
  )
    throw new Error(
      "one complete original Gemini candidate without error required",
    );
  const c = body.candidates[0];
  if (
    !c ||
    typeof c !== "object" ||
    Array.isArray(c) ||
    c.index !== 0 ||
    c.finishReason !== "STOP"
  )
    throw new Error(
      "original Gemini finishReason must be explicit STOP with index0",
    );
  if (
    body.promptFeedback !== undefined &&
    (!body.promptFeedback ||
      typeof body.promptFeedback !== "object" ||
      Array.isArray(body.promptFeedback))
  )
    throw new Error("original prompt feedback must be an object");
  if (
    body.promptFeedback?.blockReason !== undefined ||
    body.promptFeedback?.blockReasonMessage !== undefined
  )
    throw new Error("original Gemini response is blocked or ambiguous");
  for (const ratings of [c.safetyRatings, body.promptFeedback?.safetyRatings]) {
    if (ratings === undefined) continue;
    if (
      !Array.isArray(ratings) ||
      ratings.length > 32 ||
      ratings.some(
        (r) =>
          !r ||
          typeof r !== "object" ||
          Array.isArray(r) ||
          (r.blocked !== undefined && r.blocked !== false),
      )
    )
      throw new Error(
        "original Gemini safety metadata is blocked or ambiguous",
      );
  }
  validText(body.responseId, 1, 240);
  validText(body.modelVersion, 1, 240);
  if (
    !c.content ||
    c.content.role !== "model" ||
    !Array.isArray(c.content.parts) ||
    !c.content.parts.length ||
    c.content.parts.length > 32
  )
    throw new Error("bounded complete original model parts required");
  let text = "",
    action: NativeAction | undefined,
    nativeFunctionId: string | null = null;
  for (const part of c.content.parts) {
    if (!part || typeof part !== "object" || Array.isArray(part))
      throw new Error("original model part object required");
    const metadata = ["thought", "thoughtSignature"].filter((k) =>
      Object.hasOwn(part, k),
    );
    if (Object.hasOwn(part, "thought") && typeof part.thought !== "boolean")
      throw new Error("exact original thought marker required");
    if (part.thoughtSignature !== undefined && part.thoughtSignature !== null)
      validText(part.thoughtSignature, 1, 16384);
    if (Object.hasOwn(part, "functionCall")) {
      keys(part, ["functionCall", ...metadata]);
      if (action || part.thought === true)
        throw new Error("one original native inventory function required");
      if (
        !part.functionCall ||
        typeof part.functionCall !== "object" ||
        Array.isArray(part.functionCall)
      )
        throw new Error("original function object required");
      keys(part.functionCall, [
        "name",
        "args",
        ...(Object.hasOwn(part.functionCall, "id") ? ["id"] : []),
      ]);
      if (part.functionCall.id !== undefined && part.functionCall.id !== null) {
        validText(part.functionCall.id, 1, 240);
        nativeFunctionId = part.functionCall.id;
      }
      action = toolArguments(part.functionCall.name, part.functionCall.args);
    } else {
      keys(part, ["text", ...metadata]);
      validText(part.text, 0, 16384);
      if (part.thought !== true) text += part.text;
    }
  }
  validText(text, 0, 16384);
  if (action)
    return {
      body,
      completion: {
        kind: "tool",
        action,
        nativeFunctionId,
        text,
        responseId: body.responseId,
        reportedModel: body.modelVersion,
      },
    };
  if (!text.trim())
    throw new Error("nonblank original final model text required");
  return {
    body,
    completion: {
      kind: "text",
      text,
      responseId: body.responseId,
      reportedModel: body.modelVersion,
    },
  };
}
