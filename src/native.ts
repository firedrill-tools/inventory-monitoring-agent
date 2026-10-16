/** Actual public Google SDK over one owned bounded Undici pool. */
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { Pool, fetch as httpFetch } from "undici";
import {
  completed,
  TOOL_NAMES,
  toolArguments,
  type Completion,
} from "./completion.js";
import { canonical, hash, keys, parseJSON, validText } from "./json.js";
import { Receipt, bytesImage, errorInfo, usageOf } from "./evidence.js";

export const REQUEST_LIMIT = 32,
  OUTPUT_LIMIT = 4096;
export type NativeConfig = {
  model: string;
  modelId: string;
  apiKey: string;
  baseURL: string;
};
export function config(
  model: unknown,
  key?: string,
  base?: string,
): NativeConfig {
  if (
    typeof model !== "string" ||
    !/^google\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)
  )
    throw new Error(
      "explicit INVENTORY_MODEL google/<model> required; no model fallback",
    );
  const apiKey = key ?? process.env.GOOGLE_API_KEY;
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(apiKey))
    throw new Error("GOOGLE_API_KEY required; no model fallback");
  const raw =
    base ??
    process.env.INVENTORY_BASE_URL ??
    "https://generativelanguage.googleapis.com/v1beta";
  if (raw.trim() !== raw || /[\x00-\x20\x7f]/.test(raw))
    throw new Error("canonical native provider URL required");
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/$/, "") !== "/v1beta" ||
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
  )
    throw new Error(
      "native provider requires exact HTTPS or owned loopback HTTP /v1beta without credentials/query/fragment",
    );
  return {
    model,
    modelId: model.slice(7),
    apiKey,
    baseURL: url.href.replace(/\/$/, ""),
  };
}
export type NativeOwner = {
  receipt: Receipt;
  signal: AbortSignal;
  deadline: number;
  guard: () => void;
};
export class Native {
  readonly dispatcher: Pool;
  readonly pending = new Set<Promise<unknown>>();
  private responseIds = new Set<string>();
  private functionIds = new Set<string>();
  private current:
    | { completion: Completion; used: boolean; call: Record<string, any> }
    | undefined;
  closeAttempted = false;
  closed = false;
  failure: unknown;
  constructor(
    readonly configured: NativeConfig,
    readonly owner: NativeOwner,
  ) {
    this.dispatcher = new Pool(new URL(configured.baseURL).origin, {
      connect: { timeout: 30000 },
      headersTimeout: 30000,
      bodyTimeout: 30000,
      connections: 1,
      pipelining: 1,
    });
  }
  model() {
    const c = this.configured;
    const ownedFetch: typeof globalThis.fetch = (input, init) => {
      const work = this.forward(input, init).catch((error) => {
        this.failure ??= error;
        throw error;
      });
      this.pending.add(work);
      work.then(
        () => this.pending.delete(work),
        () => this.pending.delete(work),
      );
      return work;
    };
    return createGoogleGenerativeAI({
      apiKey: c.apiKey,
      baseURL: c.baseURL,
      fetch: ownedFetch,
    })(c.modelId);
  }
  private outgoing(input: RequestInfo | URL, init?: RequestInit) {
    const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      ),
      c = this.configured;
    if (
      url.href !== `${c.baseURL}/models/${c.modelId}:generateContent` ||
      init?.method !== "POST"
    )
      throw new Error("unqualified original Gemini request endpoint/method");
    if (
      this.current &&
      (this.current.completion.kind === "text" || !this.current.used)
    )
      throw new Error("original prior native action/final was not consumed");
    const headers = new Headers(init.headers);
    if (
      headers.get("x-goog-api-key") !== c.apiKey ||
      headers.has("authorization") ||
      headers.has("x-goog-user-project")
    )
      throw new Error("unqualified original native authentication/routing");
    if (
      typeof init.body !== "string" ||
      Buffer.byteLength(init.body) > 2 * 1024 * 1024
    )
      throw new Error("bounded original native request JSON required");
    const body = parseJSON(Buffer.from(init.body)) as Record<string, any>;
    keys(body, [
      "generationConfig",
      "contents",
      "systemInstruction",
      "tools",
      "toolConfig",
    ]);
    keys(body.generationConfig, ["maxOutputTokens"]);
    if (
      body.generationConfig.maxOutputTokens !== OUTPUT_LIMIT ||
      !Array.isArray(body.contents) ||
      !body.contents.length ||
      body.contents.length > 256 ||
      !Array.isArray(body.tools) ||
      body.tools.length !== 1
    )
      throw new Error("unqualified original Gemini settings/content/tools");
    keys(body.tools[0], ["functionDeclarations"]);
    const declarations = body.tools[0].functionDeclarations;
    if (
      !Array.isArray(declarations) ||
      declarations.length !== 3 ||
      canonical(declarations.map((d: any) => d.name).sort()) !==
        canonical([...TOOL_NAMES].sort())
    )
      throw new Error("exact native inventory tool declarations required");
    for (const declaration of declarations) {
      keys(declaration, ["name", "description", "parameters"]);
      validText(declaration.description, 1, 2048);
      const parameters = declaration.parameters as Record<string, any>;
      const fields =
        declaration.name === "prepareReplenishment"
          ? ["sku", "expectedRevision"]
          : ["sku"];
      if (
        parameters?.type !== "object" ||
        !parameters.properties ||
        canonical(Object.keys(parameters.properties).sort()) !==
          canonical(fields.sort()) ||
        parameters.properties.sku?.type !== "string" ||
        (fields.includes("expectedRevision") &&
          parameters.properties.expectedRevision?.type !== "integer")
      )
        throw new Error("unqualified native inventory argument schema");
      const required = parameters.required ?? [];
      if (
        canonical([...required].sort()) !==
        canonical(declaration.name === "inspectInventory" ? [] : fields.sort())
      )
        throw new Error("unqualified native required arguments");
    }
    if (
      canonical(body.toolConfig) !==
      canonical({ functionCallingConfig: { mode: "AUTO" } })
    )
      throw new Error("unqualified native tool policy");
    keys(body.systemInstruction, ["parts"]);
    if (
      !Array.isArray(body.systemInstruction.parts) ||
      body.systemInstruction.parts.length !== 1
    )
      throw new Error("one original system instruction required");
    keys(body.systemInstruction.parts[0], ["text"]);
    validText(body.systemInstruction.parts[0].text, 1, 32768);
    for (const content of body.contents) {
      keys(content, ["role", "parts"]);
      if (
        !["user", "model"].some((role) => role === content.role) ||
        !Array.isArray(content.parts) ||
        !content.parts.length ||
        content.parts.length > 64
      )
        throw new Error("exact original native message content required");
      for (const part of content.parts) {
        if (
          !part ||
          typeof part !== "object" ||
          Array.isArray(part) ||
          !Object.keys(part).every((k) =>
            [
              "text",
              "functionCall",
              "functionResponse",
              "thoughtSignature",
              "thought",
            ].includes(k),
          )
        )
          throw new Error(
            "native files/grounding/execution/media are not inventory tools",
          );
        const actions = ["text", "functionCall", "functionResponse"].filter(
          (k) => Object.hasOwn(part, k),
        );
        if (actions.length !== 1)
          throw new Error("one native message part content required");
        if (actions[0] === "text") validText(part.text, 0, 2 * 1024 * 1024);
        if (actions[0] === "functionCall")
          toolArguments(part.functionCall?.name, part.functionCall?.args);
        if (
          actions[0] === "functionResponse" &&
          !TOOL_NAMES.some(
            (name) => name === (part.functionResponse as any)?.name,
          )
        )
          throw new Error("unknown native inventory tool response");
      }
    }
    return { url, raw: Buffer.from(init.body), body };
  }
  private async forward(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (this.failure) throw this.failure;
    this.owner.guard();
    if (this.closeAttempted) throw new Error("native pool is closing");
    const { url, raw, body } = this.outgoing(input, init),
      receipt = this.owner.receipt;
    if (receipt.data.calls.length >= REQUEST_LIMIT)
      throw new Error("prepared native request budget exhausted");
    const call: Record<string, any> = {
      number: receipt.data.calls.length + 1,
      status: "prepared",
      preparedAt: new Date().toISOString(),
      requestedModel: this.configured.modelId,
      method: "POST",
      origin: url.origin,
      path: url.pathname,
      request: bytesImage(raw),
      requestBody: body,
      reportedUsage: usageOf(null),
    };
    receipt.data.calls.push(call);
    receipt.save();
    if (this.failure) throw this.failure;
    this.owner.guard();
    const phase = AbortSignal.timeout(
      Math.min(
        30000,
        Math.max(1, Math.ceil(this.owner.deadline - performance.now())),
      ),
    );
    const signal = AbortSignal.any([
      this.owner.signal,
      phase,
      ...(init?.signal ? [init.signal] : []),
    ]);
    const chunks: Buffer[] = [];
    let length = 0,
      complete = false;
    try {
      call.status = "dispatched";
      call.dispatchedAt = new Date().toISOString();
      receipt.save();
      const response = await httpFetch(url.href, {
        ...init,
        dispatcher: this.dispatcher,
        redirect: "error",
        signal,
      } as Parameters<typeof httpFetch>[1]);
      call.httpStatus = response.status;
      call.responseHeaders = Object.fromEntries(
        [...response.headers].filter(([k]) =>
          [
            "content-type",
            "x-request-id",
            "x-goog-request-id",
            "retry-after",
            "content-encoding",
            "content-length",
          ].includes(k),
        ),
      );
      const reader = response.body?.getReader();
      if (!reader) complete = true;
      if (reader)
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) {
              complete = true;
              break;
            }
            length += next.value.byteLength;
            if (length > 1024 * 1024) {
              const remaining =
                1024 * 1024 - chunks.reduce((n, b) => n + b.length, 0);
              if (remaining > 0)
                chunks.push(Buffer.from(next.value).subarray(0, remaining));
              throw new Error("original native decoded response exceeds1MiB");
            }
            chunks.push(Buffer.from(next.value));
          }
        } finally {
          try {
            await reader.cancel();
          } finally {
            reader.releaseLock();
          }
        }
      const bytes = Buffer.concat(chunks);
      call.response = bytesImage(bytes, complete, length);
      let original: unknown;
      try {
        original = parseJSON(bytes);
        call.responseBody = original;
        call.reportedUsage = usageOf(original);
      } catch (error) {
        call.originalParseError = errorInfo(error);
        throw error;
      }
      receipt.save();
      if (
        response.status !== 200 ||
        !response.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("application/json")
      )
        throw new Error("original Gemini response must be HTTP200 JSON");
      const qualified = completed(bytes);
      if (this.responseIds.has(qualified.completion.responseId))
        throw new Error("replayed original Gemini responseId");
      if (
        qualified.completion.kind === "tool" &&
        qualified.completion.nativeFunctionId !== null
      ) {
        if (this.functionIds.has(qualified.completion.nativeFunctionId))
          throw new Error("replayed original Gemini function ID");
        this.functionIds.add(qualified.completion.nativeFunctionId);
      }
      this.responseIds.add(qualified.completion.responseId);
      this.current = {
        completion: structuredClone(qualified.completion),
        used: false,
        call,
      };
      call.originalCompletion = structuredClone(qualified.completion);
      call.status = "qualified";
      if (this.failure) throw this.failure;
      this.owner.guard();
      receipt.save();
      const headers = new Headers([...response.headers]);
      for (const k of [
        "content-length",
        "content-encoding",
        "transfer-encoding",
      ])
        headers.delete(k);
      return new Response(bytes, { status: response.status, headers });
    } catch (error) {
      call.status = "failed";
      call.error = errorInfo(error);
      call.response ??= bytesImage(Buffer.concat(chunks), complete, length);
      try {
        receipt.save();
      } catch {}
      throw error;
    } finally {
      call.finishedAt = new Date().toISOString();
    }
  }
  beforeTool(name: string, args: Record<string, unknown>) {
    if (this.failure) throw this.failure;
    this.owner.guard();
    const current = this.current;
    if (
      !current ||
      current.used ||
      current.completion.kind !== "tool" ||
      current.completion.action.name !== name ||
      canonical(current.completion.action.args) !== canonical(args)
    )
      throw new Error(
        "actual SDK tool differs from own unused original Gemini function",
      );
    current.used = true;
    current.call.sdkToolEnteredAt = new Date().toISOString();
    this.owner.receipt.save();
  }
  step(step: any) {
    if (this.failure) throw this.failure;
    this.owner.guard();
    const current = this.current;
    if (!current) throw new Error("SDK step has no original native response");
    const calls = step.toolCalls ?? [],
      items = calls.map((call: any) => call.payload ?? call);
    if (current.completion.kind === "tool") {
      if (
        !current.used ||
        step.finishReason !== "tool-calls" ||
        items.length !== 1 ||
        items[0].toolName !== current.completion.action.name ||
        canonical(items[0].args) !== canonical(current.completion.action.args)
      )
        throw new Error(
          "SDK tool normalization contradicts original native function",
        );
      validText(items[0].toolCallId, 1, 240);
      if (
        current.completion.nativeFunctionId !== null &&
        items[0].toolCallId !== current.completion.nativeFunctionId
      )
        throw new Error("SDK reported function identity differs from original");
    } else if (
      items.length ||
      step.finishReason !== "stop" ||
      step.text !== current.completion.text
    )
      throw new Error(
        "SDK final normalization contradicts original native text",
      );
    this.owner.receipt.data.sdk.push({
      call: current.call.number,
      finishReason: step.finishReason,
      text: step.text ?? null,
      toolCalls: structuredClone(items),
      usage: structuredClone(step.usage ?? null),
      originalResponseId: current.completion.responseId,
      reportedNativeFunctionId:
        current.completion.kind === "tool"
          ? current.completion.nativeFunctionId
          : null,
    });
    this.owner.receipt.save();
  }
  final(text: unknown, finishReason: unknown) {
    const current = this.current;
    if (
      !current ||
      current.completion.kind !== "text" ||
      finishReason !== "stop" ||
      text !== current.completion.text
    )
      throw new Error("actual SDK final has no own completed original text");
  }
  async close() {
    if (this.closeAttempted)
      throw new Error("native pool close already attempted");
    this.closeAttempted = true;
    await Promise.allSettled([...this.pending]);
    await this.dispatcher.close();
    this.closed = true;
  }
}
