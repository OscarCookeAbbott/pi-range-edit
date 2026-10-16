import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, initTheme, renderDiff, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import extension from "../src/index.ts";
initTheme("dark");
const original = "header\nstart\nold\nend\nfooter\n";
const edits = [{ start: { line: 2, text: "start" }, end: { line: 4, text: "end" }, newText: "start\nnew\nend" }];
interface Details { status: string; path: string; pendingId?: string; summary: string; diff: string; ownEdits: number; additions: number; deletions: number; ranges: { start: number; end: number }[] }

async function harness(t: TestContext, settings: unknown = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-range-edit-integration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requestedPath = join(directory, "file.txt");
  await writeFile(requestedPath, original);
  const path = await realpath(requestedPath);
  const handlers = new Map<string, (event: any, ctx: ExtensionToolContext) => any>();
  const tools = new Map<string, ToolDefinition<TSchema, Details>>();
  const notifications: string[] = [];
  const ctx = { cwd: directory, ui: { notify: (text: string) => notifications.push(text) } } as unknown as ExtensionToolContext;
  extension({
    on: (event: string, handler: any) => handlers.set(event, handler),
    registerTool: (tool: ToolDefinition<TSchema, Details>) => tools.set(tool.name, tool),
    getSettings: () => settings,
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  await emit("session_start");
  let id = 0;
  async function invoke(tool: ToolDefinition<TSchema, any>, input: Record<string, unknown>, after?: () => Promise<void>) {
    const toolCallId = `call-${++id}`;
    const prepared = tool.prepareArguments ? tool.prepareArguments(structuredClone(input)) : input;
    const validated = validateToolArguments(tool, { type: "toolCall", id: toolCallId, name: tool.name, arguments: prepared as JsonObject });
    await emit("tool_call", { toolName: tool.name, toolCallId, input: validated });
    try {
      const result = await tool.execute(toolCallId, validated, undefined, undefined, ctx);
      if (after) await after();
      await emit("tool_result", { toolName: tool.name, toolCallId, input: validated, ...result, isError: result.isError ?? false });
      return result;
    } catch (error) {
      await emit("tool_result", { toolName: tool.name, toolCallId, input: validated, isError: true, content: [] });
      throw error;
    }
  }
  const native = {
    read: createReadToolDefinition(directory),
    edit: createEditToolDefinition(directory),
    write: createWriteToolDefinition(directory),
  };
  return {
    path, directory, tools, notifications, emit,
    async range(input: Record<string, unknown>) { return invoke(tools.get("range_edit")!, input) as Promise<{ isError?: boolean; structuredContent: { status: string; pendingId?: string; diff: string; diffTruncated: boolean }; details: Details; content: { type: string; text: string }[] }>; },
    async native(name: keyof typeof native, input: Record<string, unknown>, after?: () => Promise<void>) { return invoke(native[name], input, after); },
  };
}

test("the extension registers only range_edit and observes ordinary read/edit/write without overrides", async (t) => {
  const h = await harness(t);
  assert.deepEqual([...h.tools.keys()], ["range_edit"]);
  assert.equal(h.tools.get("range_edit")!.executionMode, "sequential");
  await h.native("read", { path: h.path });
  await h.native("edit", { path: h.path, edits: [{ oldText: "old", newText: "native" }] });
  const result = await h.range({ path: h.path, edits });
  assert.equal(result.details.status, "applied");
  assert.equal(result.content[0].text, "Success. +1 -1 lines.");
  assert.equal(result.details.ownEdits, 1);
  assert.equal(await readFile(h.path, "utf8"), original.replace("old", "new"));
  assert.ok(!("before" in result.details) && !("after" in result.details));

  const created = join(h.directory, "created.txt");
  await h.native("write", { path: created, content: original });
  assert.equal((await h.range({ path: created, edits })).details.status, "applied");
});

test("Pi error results with empty details render the actual refusal", async (t) => {
  const h = await harness(t);
  const text = "edits[0]: No matching end boundary. Nothing written.";
  const result = { content: [{ type: "text", text }], details: {} };
  const render = h.tools.get("range_edit")!.renderResult! as Function;
  for (const expanded of [false, true]) {
    assert.equal(render(result, { expanded }, { fg: (_color: string, text: string) => text }, {}).render(200).join("\n").trimEnd(), text);
  }
});

test("successful feedback counts actual changes without adding diff bodies to model context", async (t) => {
  for (const [newText, expected, additions, deletions] of [
    ["new", "Success. +1 -1 lines.", 1, 1],
    ["old\nextra", "Success. +1 -0 lines.", 1, 0],
    ["", "Success. +0 -1 lines.", 0, 1],
    ["old", "No changes.", 0, 0],
    [Array.from({ length: 300 }, (_, i) => `new ${i}`).join("\n"), "Success. +300 -1 lines.", 300, 1],
  ] as const) {
    const h = await harness(t);
    await h.native("read", { path: h.path });
    const result = await h.range({ path: h.path, edits: [{ start: { line: 3, text: "old" }, newText }] });
    assert.equal(result.content[0].text, expected);
    assert.equal(result.details.additions, additions);
    assert.equal(result.details.deletions, deletions);
    const tool = h.tools.get("range_edit")!;
    const render = tool.renderResult! as Function;
    const theme = { fg: (_color: string, text: string) => text };
    const collapsed = render(result, { expanded: false }, theme, {}).render(200).map((line: string) => line.trimEnd()).join("\n");
    assert.ok(collapsed.startsWith(expected));
    if (additions || deletions) assert.match(collapsed, /old/);
    else assert.equal(collapsed, expected);
    const expanded = render(result, { expanded: true }, theme, {}).render(200).join("\n");
    assert.ok(expanded.includes(h.path));
    if (additions || deletions) {
      assert.match(result.details.diff, /old/);
      assert.match(expanded, /Range 1: requested/);
      assert.match(expanded, /old/);
    }
  }
});

test("TUI uses built-in diff highlighting and bold/accented call headers", async (t) => {
  const h = await harness(t);
  const tool = h.tools.get("range_edit")!;
  const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `<bold>${text}</bold>` };
  const call = (tool.renderCall! as Function)({ path: "src/example.ts" }, theme, {}).render(200).join("\n").trimEnd();
  assert.equal(call, "<toolTitle><bold>range_edit</bold></toolTitle> <accent>src/example.ts</accent>");
  await h.native("read", { path: h.path });
  const result = await h.range({ path: h.path, edits });
  const rendered = (tool.renderResult! as Function)(result, { expanded: false }, theme, {}).render(200).map((line: string) => line.trimEnd()).join("\n");
  assert.ok(rendered.includes(renderDiff(result.details.diff)));
  assert.equal(result.content[0].text, "Success. +1 -1 lines.");
});

test("relocation reports signed offsets without repeating exact ranges", async (t) => {
  const h = await harness(t);
  await h.native("write", { path: h.path, content: `prefix\n${original}` });
  const shifted = await h.range({ path: h.path, edits });
  assert.equal(shifted.content[0].text, "Success with +1 line offset. +1 -1 lines.");
  const batch = await h.range({ path: h.path, edits: [
    { start: { line: 2, text: "header" }, newText: "header" },
    { start: { line: 5, text: "footer" }, newText: "tail" },
  ] });
  assert.equal(batch.content[0].text, "Success. +1 -1 lines. Range 2 offset +1.");
  const negative = await h.range({ path: h.path, edits: [{ start: { line: 5, text: "new" }, newText: "final" }] });
  assert.equal(negative.content[0].text, "Success with -1 line offset. +1 -1 lines.");
});

test("unexpected interior changes return a reviewable warning; reapply cannot alter the saved instructions", async (t) => {
  const h = await harness(t);
  await h.native("read", { path: h.path });
  await writeFile(h.path, original.replace("old", "external"));
  const pending = await h.range({ path: h.path, edits });
  assert.equal(pending.isError, true);
  assert.equal(pending.structuredContent.status, "pending");
  assert.equal(pending.structuredContent.pendingId, pending.details.pendingId);
  assert.match(pending.structuredContent.diff, /external/);
  assert.equal(pending.structuredContent.diffTruncated, false);
  assert.match(pending.details.summary, /unaccounted-for.*Nothing written/);
  assert.match(pending.details.diff, /external/);
  assert.equal(await readFile(h.path, "utf8"), original.replace("old", "external"));
  await assert.rejects(h.range({ action: "reapply", pendingId: pending.details.pendingId, path: h.path, edits }), /no new edit/);
  const applied = await h.range({ action: "reapply", pendingId: pending.details.pendingId });
  assert.equal(applied.isError, false);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.pendingId, undefined);
  assert.equal(await readFile(h.path, "utf8"), original.replace("old", "new"));
});

test("large unverified proposals keep bounded review evidence and do not write", async (t) => {
  const h = await harness(t);
  const pending = await h.range({ path: h.path, edits: [{ start: { line: 3, text: "old" }, newText: Array.from({ length: 300 }, (_, i) => `new ${i}`).join("\n") }] });
  assert.equal(pending.isError, true);
  assert.match(pending.content[0].text, /Nothing written.*Pending edit:/);
  assert.match(pending.content[0].text, /Diff truncated.*Read the affected file ranges/);
  assert.equal(pending.structuredContent.diffTruncated, true);
  assert.match(pending.content[0].text, /new 0/);
  assert.equal(await readFile(h.path, "utf8"), original);
});

test("unstable reads and unexpected post-tool bytes never become trusted agent versions", async (t) => {
  const h = await harness(t);
  await h.native("read", { path: h.path }, () => writeFile(h.path, original.replace("old", "changed during read")));
  const unknown = await h.range({ path: h.path, edits });
  assert.equal(unknown.details.status, "pending");
  assert.match(unknown.details.summary, /No recorded/);
  await h.native("read", { path: h.path });
  await h.native("edit", { path: h.path, edits: [{ oldText: "changed during read", newText: "native" }] }, () => writeFile(h.path, `${original.replace("old", "native")}unexpected\n`));
  assert.match((await h.range({ path: h.path, edits })).details.summary, /unaccounted-for/);
  await h.native("read", { path: h.path });
  await writeFile(h.path, `${original.replace("old", "native")}another external change\n`);
  await h.native("edit", { path: h.path, edits: [{ oldText: "native", newText: "partial known edit" }] });
  assert.match((await h.range({ path: h.path, edits })).details.summary, /unaccounted-for/);
});

test("same-file concurrent requests serialize and safely relocate after known edits", async (t) => {
  const h = await harness(t);
  await h.native("read", { path: h.path });
  const results = await Promise.all([
    h.range({ path: h.path, edits: [{ start: { line: 1, text: "header" }, newText: "prefix\nheader" }] }),
    h.range({ path: h.path, edits: [{ start: { line: 3, text: "old" }, newText: "new" }] }),
  ]);
  assert.ok(results.every((result) => result.details.status === "applied"));
  assert.equal(await readFile(h.path, "utf8"), `prefix\n${original.replace("old", "new")}`);
});

test("configured radius, schema validation, and lifecycle resets do not bypass safety checks", async (t) => {
  const h = await harness(t, { rangeEdit: { maxLineShift: 1 } });
  await h.native("read", { path: h.path });
  await writeFile(h.path, `one\ntwo\n${original}`);
  await assert.rejects(h.range({ path: h.path, edits }), /No matching/);
  await assert.rejects(h.range({ path: h.path, edits, maxLineShift: 2 }), /configured limit/);
  await assert.rejects(h.range({ path: h.path, edits: [{ start: { line: 0, text: "one" }, newText: "bad" }] }), /validation/i);
  await writeFile(h.path, original);
  await h.emit("session_tree");
  const pending = await h.range({ path: h.path, edits });
  assert.equal(pending.details.status, "pending");
  await h.emit("session_shutdown");
  await assert.rejects(h.range({ action: "reapply", pendingId: pending.details.pendingId }), /expired/);
  const invalid = await harness(t, { rangeEdit: { maxLineShift: -1 } });
  assert.match(invalid.notifications[0], /Using defaults/);
});

test("pi-lens sees applied mutations only, and reporting failures do not misreport a successful write", async (t) => {
  const symbol = Symbol.for("pi-lens:io-bridge");
  const globals = globalThis as Record<symbol, unknown>;
  const previous = globals[symbol];
  t.after(() => { if (previous === undefined) delete globals[symbol]; else globals[symbol] = previous; });
  const reports: any[] = [];
  globals[symbol] = { version: 2, record: (entry: any) => { reports.push(entry); return { mutate: { accepted: true } }; } };
  const h = await harness(t);
  const pending = await h.range({ path: h.path, edits });
  assert.equal(reports.length, 0);
  await h.range({ action: "reapply", pendingId: pending.details.pendingId });
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].mutate.ranges, [[2, 4]]);
  assert.equal(reports[0].consumer, "range_edit");
  globals[symbol] = { version: 2, record: () => ({ mutate: { accepted: false, reason: "stale-lineage" } }) };
  const applied = await h.range({ path: h.path, edits: [{ start: { line: 3, text: "new" }, newText: "final" }] });
  assert.equal(applied.details.status, "applied");
  assert.equal(applied.isError, false);
  assert.match(applied.details.summary, /reporting.*not accepted/);
  assert.equal(await readFile(h.path, "utf8"), original.replace("old", "final"));
});
