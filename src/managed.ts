/** Durable scoped local inventory operations, with independent source ownership. */
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type Action, type InventoryEvent, transition } from "./domain.js";
import { canonical, hash } from "./json.js";
import { projection } from "./schema.js";
import { readOriginal } from "./workspace.js";
import * as state from "./managed-state.js";

const physical = (s: { dev: bigint; ino: bigint }) => `${s.dev}:${s.ino}`;
export type Credential = { id: string; token: string };
export type ReadProof = { id: string; token: string };
export class ManagedWorkspace {
  readonly path: string;
  readonly identity: state.Identity;
  instanceId: string | undefined;
  sourceDocumentSha256: string | undefined;
  private db: DatabaseSync | undefined;
  private guardFd: number | null = null;
  private databaseOpened = false;
  closeAttempted = false;
  databaseCloseAttempted = false;
  databaseClosed = false;
  guardCloseAttempted = false;
  guardClosed = false;
  closed = false;
  commitGuard = () => {};
  constructor(path: string) {
    const supplied = resolve(path);
    this.path = join(realpathSync(dirname(supplied)), basename(supplied));
    const current = lstatSync(this.path, { bigint: true });
    if (
      !current.isFile() ||
      current.nlink !== 1n ||
      current.size <= 0n ||
      current.size > BigInt(state.MAX_DATABASE_BYTES)
    )
      throw new Error(
        "bounded regular unshared nonsymlink managed database required",
      );
    this.identity = {
      database: physical(current),
      parent: physical(lstatSync(dirname(this.path), { bigint: true })),
      name: basename(this.path),
    };
    try {
      this.guardFd = openSync(
        this.path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      this.guard();
      this.db = new DatabaseSync(this.path, {
        open: false,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        allowExtension: false,
      });
      this.db.open();
      this.databaseOpened = true;
      this.db.exec(
        "PRAGMA busy_timeout=250; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;",
      );
      const initial = this.snapshot();
      this.instanceId = initial.source.instanceId;
      this.sourceDocumentSha256 = hash(initial.original.sourceDocument);
    } catch (error) {
      try {
        this.close();
      } catch (closeError) {
        if (error instanceof Error)
          (error as any).sourceCloseError = closeError;
      }
      if (error instanceof Error) (error as any).managedSource = this;
      throw error;
    }
  }
  assertCurrentIdentity() {
    this.guard();
  }
  private guard() {
    if (this.closeAttempted || this.guardFd === null)
      throw new Error("managed inventory source is closed");
    const pin = fstatSync(this.guardFd, { bigint: true }),
      current = lstatSync(this.path, { bigint: true });
    if (
      pin.nlink !== 1n ||
      current.nlink !== 1n ||
      !current.isFile() ||
      physical(pin) !== this.identity.database ||
      physical(current) !== this.identity.database ||
      physical(lstatSync(dirname(this.path), { bigint: true })) !==
        this.identity.parent
    )
      throw new Error("original managed database/root identity changed");
  }
  close() {
    if (this.closeAttempted)
      throw new Error("managed inventory close already attempted");
    this.closeAttempted = true;
    const errors: unknown[] = [];
    if (this.databaseOpened) {
      this.databaseCloseAttempted = true;
      try {
        this.db!.close();
        this.databaseClosed = true;
      } catch (e) {
        errors.push(e);
      }
    }
    this.guardCloseAttempted = this.guardFd !== null;
    const fd = this.guardFd;
    this.guardFd = null;
    if (fd !== null)
      try {
        closeSync(fd);
        this.guardClosed = true;
      } catch (e) {
        errors.push(e);
      }
    this.closed = !errors.length;
    if (errors.length)
      throw new AggregateError(errors, "managed inventory source close failed");
  }
  static seed(path: string, fixture: string) {
    const initial = readOriginal(resolve(fixture));
    const supplied = resolve(path);
    mkdirSync(dirname(supplied), { recursive: true, mode: 0o700 });
    const database = join(realpathSync(dirname(supplied)), basename(supplied));
    const fd = openSync(
        database,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
        0o600,
      ),
      created = fstatSync(fd, { bigint: true });
    const identity: state.Identity = {
      database: physical(created),
      parent: physical(lstatSync(dirname(database), { bigint: true })),
      name: basename(database),
    };
    let db: DatabaseSync | undefined,
      opened = false;
    try {
      db = new DatabaseSync(database, { open: false, allowExtension: false });
      db.open();
      opened = true;
      db.exec(
        `PRAGMA page_size=4096; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE; PRAGMA application_id=${state.APPLICATION_ID}; PRAGMA user_version=${state.SCHEMA_VERSION};`,
      );
      for (const sql of Object.values(state.TABLES)) db.exec(sql);
      const doc: state.Header = {
        schemaVersion: state.SCHEMA_VERSION,
        instanceId: randomUUID(),
        identity,
        fixtureBase64: initial.raw.toString("base64"),
        fixtureSha256: hash(initial.raw),
        provenance: state.PROVENANCE,
        creation: "fixture",
        population: null,
      };
      db.prepare("INSERT INTO metadata VALUES (1,?)").run(canonical(doc));
      db.prepare("INSERT INTO business VALUES (1,?)").run(
        canonical(projection(initial.state)),
      );
      state.snapshot(db, identity, doc.instanceId);
      const current = lstatSync(database, { bigint: true });
      if (
        physical(current) !== physical(created) ||
        current.nlink !== 1n ||
        fstatSync(fd, { bigint: true }).nlink !== 1n
      )
        throw new Error("managed inventory seed destination changed");
      db.exec("COMMIT");
      fsyncSync(fd);
      const parent = openSync(dirname(database), constants.O_RDONLY);
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    } catch (error) {
      if (opened)
        try {
          db!.exec("ROLLBACK");
        } catch {}
      throw error;
    } finally {
      try {
        if (opened) db!.close();
      } finally {
        closeSync(fd);
      }
    }
    return new ManagedWorkspace(database);
  }
  private transaction<T>(
    write: boolean,
    action: (db: DatabaseSync, before: state.Snapshot) => T,
  ): T {
    this.guard();
    const db = this.db!;
    db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const before = state.snapshot(db, this.identity, this.instanceId);
      this.headerGuard(before.original.sourceDocument);
      const result = action(db, before);
      if (write) {
        const after = state.snapshot(db, this.identity, this.instanceId);
        this.headerGuard(after.original.sourceDocument);
        this.commitGuard();
      }
      this.guard();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  private headerGuard(raw: string) {
    if (
      this.sourceDocumentSha256 !== undefined &&
      hash(raw) !== this.sourceDocumentSha256
    )
      throw new Error("original managed inventory source document changed");
  }
  snapshot() {
    return this.transaction(false, (_db, before) => before);
  }
  inspectIntent(skus?: string[]): state.Intent {
    const source = this.snapshot(),
      targets = skus ?? source.business.items.map((r) => r.sku);
    if (
      !Array.isArray(targets) ||
      !targets.length ||
      new Set(targets).size !== targets.length
    )
      throw new Error("exact unique caller SKU IDs required");
    const intent = {
      targets: targets.map(
        (sku) => state.publicStock(source.business, sku).item,
      ),
      sourceContextSha256: source.contextSha256,
    };
    state.validateIntent(intent);
    return intent;
  }
  registerOperation(
    taskSha256: string,
    allowWrites: boolean,
    intent: state.Intent,
  ): Credential {
    state.hex(taskSha256);
    state.validateIntent(intent);
    if (typeof allowWrites !== "boolean")
      throw new Error("exact write permission required");
    return this.transaction(true, (db, before) => {
      if (before.records.operations.some((o) => o.status === "active"))
        throw new Error("another cooperative inventory scope is active");
      if (
        before.contextSha256 !== intent.sourceContextSha256 ||
        intent.targets.some(
          (t) =>
            !state.same(
              t,
              before.business.items.find((r) => r.sku === t.sku),
            ),
        )
      )
        throw new Error("current exact caller inventory intent required");
      const token = randomBytes(32).toString("hex"),
        op = state.sealed({
          id: randomUUID(),
          instanceId: before.source.instanceId,
          tokenSha256: hash(token),
          taskSha256,
          allowWrites,
          intent: structuredClone(intent),
          initialFrontier: before.records.decisions.length,
          status: "active" as const,
        });
      db.prepare("INSERT INTO operations VALUES (?,?,?)").run(
        op.id,
        op.tokenSha256,
        canonical(op),
      );
      return { id: op.id, token };
    });
  }
  private operation(credential: Credential, source: state.Snapshot) {
    state.uuid(credential.id);
    state.hex(credential.token);
    const op = source.records.operations.find(
      (o) => o.id === credential.id && o.tokenSha256 === hash(credential.token),
    );
    if (!op || op.status !== "active")
      throw new Error("operation_closed_or_unknown");
    return op;
  }
  currentOperation(credential: Credential) {
    return this.transaction(false, (_db, before) =>
      structuredClone(this.operation(credential, before)),
    );
  }
  closeOperation(credential: Credential) {
    state.uuid(credential.id);
    state.hex(credential.token);
    this.guard();
    const db = this.db!;
    db.exec("BEGIN IMMEDIATE");
    try {
      state.schema(db);
      const h = state.header(db, this.identity, this.instanceId);
      this.headerGuard(h.raw);
      const entries = state.rows(
          db,
          "operations",
          state.LIMITS.operations,
          "rowid",
        ),
        entry = entries.find(
          (r) =>
            r.id === credential.id && r.token_sha256 === hash(credential.token),
        );
      if (!entry) throw new Error("operation_closed_or_unknown");
      const op = state.jsonCell(entry.document) as state.Operation;
      state.operation(op);
      if (
        op.id !== entry.id ||
        op.instanceId !== h.doc.instanceId ||
        op.tokenSha256 !== entry.token_sha256
      )
        throw new Error("original inventory scope close identity differs");
      const closed =
        op.status === "closed"
          ? op
          : (state.sealed({
              ...Object.fromEntries(
                Object.entries(op).filter(([k]) => k !== "contentSha256"),
              ),
              status: "closed",
            }) as state.Operation);
      if (op.status !== "closed")
        db.prepare("UPDATE operations SET document=? WHERE id=?").run(
          canonical(closed),
          op.id,
        );
      state.schema(db);
      this.headerGuard(state.header(db, this.identity, this.instanceId).raw);
      this.guard();
      db.exec("COMMIT");
      return structuredClone(closed);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  observe(credential: Credential, sku: string) {
    return this.transaction(true, (db, before) => {
      const op = this.operation(credential, before);
      if (!op.intent.targets.some((t) => t.sku === sku))
        throw new Error("SKU outside caller inventory intent");
      const token = randomBytes(32).toString("hex"),
        value = state.publicStock(before.business, sku),
        read = state.sealed({
          id: randomUUID(),
          sequence: before.records.observations.length + 1,
          instanceId: before.source.instanceId,
          operationId: op.id,
          purpose: "inspect" as const,
          sku,
          frontier: before.records.decisions.length,
          contextSha256: before.contextSha256,
          value,
          tokenSha256: hash(token),
        });
      db.prepare("INSERT INTO observations VALUES (?,?,?,?)").run(
        read.id,
        read.sequence,
        read.operationId,
        canonical(read),
      );
      return {
        value: structuredClone(value),
        observation: structuredClone(read),
        proof: { id: read.id, token },
      };
    });
  }
  commit(
    credential: Credential,
    proof: ReadProof,
    action: Exclude<Action, { kind: "event" }>,
  ) {
    state.uuid(proof.id);
    state.hex(proof.token);
    return this.transaction(true, (db, before) => {
      const op = this.operation(credential, before);
      if (!op.allowWrites) throw new Error("writes_not_authorized");
      const read = before.records.observations.find(
        (r) => r.id === proof.id && r.tokenSha256 === hash(proof.token),
      );
      if (
        !read ||
        read.operationId !== op.id ||
        read.sku !== action.args.sku ||
        read.contextSha256 !== before.contextSha256 ||
        read.frontier !== before.records.decisions.length ||
        before.records.decisions.some((d) => d.readId === read.id)
      )
        throw new Error("current own unused inventory read required");
      const row = before.business.items.find((r) => r.sku === action.args.sku),
        target = op.intent.targets.find((r) => r.sku === action.args.sku);
      if (!row || !target || row.name !== target.name)
        throw new Error("caller SKU/name identity changed");
      return this.decide(db, before, action, op.id, read.id);
    });
  }
  event(event: InventoryEvent) {
    return this.transaction(true, (db, before) =>
      this.decide(db, before, { kind: "event", args: event }, null, null),
    );
  }
  private decide(
    db: DatabaseSync,
    before: state.Snapshot,
    action: Action,
    operationId: string | null,
    readId: string | null,
  ) {
    const next = transition(before.business, action),
      changed = !state.same(before.business, next.business);
    const decision = state.sealed({
      id: randomUUID(),
      sequence: before.records.decisions.length + 1,
      instanceId: before.source.instanceId,
      operationId,
      kind: action.kind,
      readId,
      args: structuredClone(action.args),
      status: !next.result.ok ? "denied" : changed ? "applied" : "unchanged",
      result: next.result,
      beforeContextSha256: before.contextSha256,
      afterContextSha256: state.digest(
        state.context(
          before.source,
          before.records.decisions.length + 1,
          next.business,
        ),
      ),
    });
    if (changed)
      db.prepare("UPDATE business SET document=? WHERE id=1").run(
        canonical(next.business),
      );
    db.prepare("INSERT INTO decisions VALUES (?,?,?,?)").run(
      decision.id,
      decision.sequence,
      operationId,
      canonical(decision),
    );
    return {
      result: structuredClone(next.result),
      decision: structuredClone(decision),
    };
  }
}
