import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_CONFIG, digest, RangeEditor, readConfig, type MutationQueue } from "../src/editor.ts";

const original = "header\nstart\nold\nend\nfooter\n";
const edits = [{ start: { line: 2, text: "start" }, end: { line: 4, text: "end" }, newText: "start\nnew\nend" }];
const queue: MutationQueue = async (_path, operation) => operation();
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-range-edit-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requestedPath = join(directory, "file.txt");
  await writeFile(requestedPath, original);
  const path = await realpath(requestedPath);
  const editor = new RangeEditor(queue);
  return { directory, path, editor };
}

test("a recorded read allows chained own edits without rereading or blocking", async (t) => {
  const { path, editor } = await fixture(t);
  editor.recordRead(path, digest(original));
  const first = await editor.edit({ path, edits }, "/");
  assert.equal(first.status, "applied");
  assert.equal(first.ownEdits, 0);
  const second = await editor.edit({ path, edits: [{ start: { line: 3, text: "new" }, newText: "again" }] }, "/");
  assert.equal(second.status, "applied");
  assert.equal(second.ownEdits, 1);
  assert.equal(await readFile(path, "utf8"), original.replace("old", "again"));
});

test("unseen versions and changed interiors warn without writing; reapply acknowledges only that version", async (t) => {
  const { path, editor } = await fixture(t);
  const unverified = await editor.edit({ path, edits }, "/");
  assert.equal(unverified.status, "pending");
  assert.match(unverified.reason!, /No recorded/);
  assert.equal(await readFile(path, "utf8"), original);
  editor.recordRead(path, digest(original));
  const external = original.replace("old", "external");
  await writeFile(path, external);
  const pending = await editor.edit({ path, edits }, "/");
  assert.equal(pending.status, "pending");
  assert.match(pending.reason!, /unaccounted-for/);
  assert.equal(await readFile(path, "utf8"), external);
  const applied = await editor.reapply(pending.pendingId!);
  assert.equal(applied.status, "applied");
  assert.equal(await readFile(path, "utf8"), original.replace("old", "new"));
  await assert.rejects(editor.reapply(pending.pendingId!), /consumed/);
  await assert.rejects(editor.reapply(unverified.pendingId!), /consumed/);
});

test("further drift replaces the pending proposal and cannot be bypassed by reapply", async (t) => {
  const { path, editor } = await fixture(t);
  const first = await editor.edit({ path, edits }, "/");
  await writeFile(path, `added\n${original}`);
  const second = await editor.reapply(first.pendingId!);
  assert.equal(second.status, "pending");
  assert.notEqual(second.pendingId, first.pendingId);
  assert.match(second.reason!, /changed again/);
  assert.equal(second.ranges[0].shift, 1);
  assert.equal(await readFile(path, "utf8"), `added\n${original}`);
  await assert.rejects(editor.reapply(first.pendingId!), /consumed/);
  await writeFile(path, `added\n${original.replace("end", "different boundary")}`);
  await assert.rejects(editor.reapply(second.pendingId!), /No matching/);
  assert.equal(await readFile(path, "utf8"), `added\n${original.replace("end", "different boundary")}`);
});

test("a fresh read permits a new edit, and acknowledgement of a no-op still establishes a version", async (t) => {
  const { path, editor } = await fixture(t);
  const pending = await editor.edit({ path, edits }, "/");
  editor.recordRead(path, digest(original));
  assert.equal((await editor.edit({ path, edits }, "/")).status, "applied");
  await assert.rejects(editor.reapply(pending.pendingId!), /consumed/);
  editor.reset();
  const current = await readFile(path, "utf8");
  const noop = await editor.edit({ path, edits: [{ start: { line: 1, text: "header" }, newText: "header" }] }, "/");
  assert.equal((await editor.reapply(noop.pendingId!)).status, "unchanged");
  assert.equal(await readFile(path, "utf8"), current);
  assert.equal((await editor.edit({ path, edits: [{ start: { line: 1, text: "header" }, newText: "changed" }] }, "/")).status, "applied");
});

test("unaccounted-for changes are not laundered by a subsequent observed partial edit", async (t) => {
  const { path, editor } = await fixture(t);
  editor.recordRead(path, digest(original));
  const external = original.replace("footer", "outside change");
  const partiallyEdited = external.replace("old", "known native edit");
  await writeFile(path, partiallyEdited);
  editor.recordKnownMutation(path, digest(external), digest(partiallyEdited));
  assert.equal((await editor.edit({ path, edits }, "/")).status, "pending");
  // A complete known write is different: its entire resulting content was supplied by the agent.
  editor.recordKnownMutation(path, digest(external), digest(partiallyEdited), true);
  assert.equal((await editor.edit({ path, edits }, "/")).status, "applied");
});

test("session resets and cancellation fence queued mutations and expire acknowledgement tokens", async (t) => {
  const { path, editor } = await fixture(t);
  const pending = await editor.edit({ path, edits }, "/");
  editor.reset();
  await assert.rejects(editor.reapply(pending.pendingId!), /expired/);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const deferred: MutationQueue = async (_path, operation) => { entered.resolve(); await release.promise; return operation(); };
  const delayed = new RangeEditor(deferred);
  delayed.recordRead(path, digest(original));
  const operation = delayed.edit({ path, edits }, "/");
  await entered.promise;
  delayed.reset();
  release.resolve();
  await assert.rejects(operation, /Session changed/);
  assert.equal(await readFile(path, "utf8"), original);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(editor.edit({ path, edits }, "/", controller.signal), /aborted/);
  assert.equal(await readFile(path, "utf8"), original);
});

test("symlink aliases share version identity, but a pending edit cannot follow a retargeted symlink", async (t) => {
  const { directory, path, editor } = await fixture(t);
  const alias = join(directory, "alias.txt");
  const other = join(directory, "other.txt");
  await symlink(path, alias);
  editor.recordRead(path, digest(original));
  assert.equal((await editor.edit({ path: alias, edits }, "/")).status, "applied");
  editor.reset();
  const pending = await editor.edit({ path: alias, edits: [{ start: { line: 1, text: "header" }, newText: "changed" }] }, "/");
  await writeFile(other, await readFile(path));
  await unlink(alias);
  await symlink(other, alias);
  await assert.rejects(editor.reapply(pending.pendingId!), /target changed/);
  assert.equal(await readFile(other, "utf8"), original.replace("old", "new"));
});

test("invalid replacement text rejects the entire batch before writing or proposing it", async (t) => {
  const { path, editor } = await fixture(t);
  for (const trusted of [true, false]) {
    editor.reset();
    if (trusted) editor.recordRead(path, digest(original));
    for (const newText of ["bad\0text", "bad\uD800text", "bad\uDC00text"]) {
      await assert.rejects(editor.edit({ path, edits: [
        { start: { line: 1, text: "header" }, newText: "changed" },
        { start: { line: 3, text: "old" }, newText },
      ] }, "/"), /Replacement.*UTF-8.*NUL/);
      assert.deepEqual(await readFile(path), Buffer.from(original));
    }
  }
  editor.recordRead(path, digest(original));
  await editor.edit({ path, edits: [{ start: { line: 3, text: "old" }, newText: "🐈 e\u0301" }] }, "/");
  assert.equal(await readFile(path, "utf8"), original.replace("old", "🐈 e\u0301"));
});

test("configuration, file limits, invalid encoding and invalid batches fail before writing", async (t) => {
  assert.deepEqual(readConfig({}), DEFAULT_CONFIG);
  assert.equal(readConfig({ rangeEdit: { maxLineShift: 0 } }).maxLineShift, 0);
  for (const rangeEdit of [null, [], { maxLineShift: -1 }, { maxLineShift: 1001 }, { maxLineShift: 1.5 }, { maxLineShift: "20" }, { maxLineShift: null }, { maxFileBytes: 0 }]) assert.throws(() => readConfig({ rangeEdit }));
  const { path, editor } = await fixture(t);
  await assert.rejects(editor.edit({ path, edits, maxLineShift: 21 }, "/"), /configured limit/);
  await assert.rejects(editor.edit({ path, edits: [edits[0], edits[0]] }, "/"), /overlap/);
  assert.equal(await readFile(path, "utf8"), original);
  editor.reset({ maxLineShift: 20, maxFileBytes: 1 });
  await assert.rejects(editor.edit({ path, edits }, "/"), /byte.*limit/);
  editor.reset(DEFAULT_CONFIG);
  for (const bytes of [Buffer.from([0xff]), Buffer.from("a\0b")]) {
    await writeFile(path, bytes);
    await assert.rejects(editor.edit({ path, edits }, "/"), /UTF-8/);
    assert.deepEqual(await readFile(path), bytes);
  }
});
