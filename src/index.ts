import { realpath } from "node:fs/promises";
import { createEditToolDefinition, generateDiffString, generateUnifiedPatch, renderDiff, truncateHead, withFileMutationQueue, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { absolutePath, DEFAULT_CONFIG, digest, RangeEditor, readConfig, readTextFile, type EditResult } from "./editor.ts";
import type { RangeEdit } from "./ranges.ts";

const boundary = Type.Object({
  line: Type.Integer({ minimum: 1, description: "Expected 1-based line number" }),
  text: Type.String({ description: "Entire boundary line, exact indentation/content, without its newline" }),
}, { additionalProperties: false });
const parameters = Type.Object({
  action: Type.Optional(Type.Union([Type.Literal("edit"), Type.Literal("reapply")], { description: "Defaults to edit; reapply acknowledges a specific pending proposal" })),
  path: Type.Optional(Type.String({ description: "File to edit; required for edit" })),
  edits: Type.Optional(Type.Array(Type.Object({
    start: boundary,
    end: Type.Optional(boundary),
    newText: Type.String({ description: "Replacement for the inclusive whole-line range; empty string deletes it" }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 32 })),
  maxLineShift: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000, description: "Narrow the configured search radius; 0 requires exact current coordinates" })),
  pendingId: Type.Optional(Type.String({ description: "Required for reapply; use the ID from the warning, with no new edit instructions" })),
}, { additionalProperties: false });

interface Observation {
  generation: number;
  path?: string;
  beforeDigest?: string;
  expectedDigest?: string;
  kind: "read" | "edit" | "write";
}
interface Details {
  status: EditResult["status"];
  path: string;
  pendingId?: string;
  summary: string;
  diff: string;
  patch: string;
  ranges: EditResult["ranges"];
  ownEdits: number;
  additions: number;
  deletions: number;
}
const readTools = new Set(["read", "read_symbol", "read_enclosing"]);

export default function rangeEditExtension(pi: ExtensionAPI): void {
  const editor = new RangeEditor(withFileMutationQueue);
  const observations = new Map<string, Observation>();

  function reset(ctx: ExtensionContext, configure: boolean): void {
    observations.clear();
    if (!configure) return editor.reset();
    try {
      editor.reset(readConfig(pi.getSettings()));
    } catch (error) {
      editor.reset(DEFAULT_CONFIG);
      ctx.ui.notify(`range_edit config: ${error instanceof Error ? error.message : String(error)} Using defaults.`, "warning");
    }
  }
  pi.on("session_start", (_event, ctx) => reset(ctx, true));
  pi.on("session_tree", (_event, ctx) => reset(ctx, false));
  pi.on("session_shutdown", () => { observations.clear(); editor.reset(); });

  pi.on("tool_call", async (event, ctx) => {
    const kind = readTools.has(event.toolName) ? "read" : event.toolName === "edit" || event.toolName === "write" ? event.toolName : undefined;
    const input = event.input as Record<string, unknown>;
    if (!kind || typeof input.path !== "string") return;
    const generation = editor.generation;
    try {
      const requestedPath = absolutePath(input.path, ctx.cwd);
      let path: string | undefined;
      try { path = await realpath(requestedPath); } catch { if (kind !== "write") return; }
      let buffer: Buffer | undefined;
      if (path) {
        try { buffer = await readTextFile(path, editor.config.maxFileBytes); } catch { if (kind !== "write") return; }
      }
      const observation: Observation = { generation, path, beforeDigest: buffer ? digest(buffer) : undefined, kind };
      if (kind === "write") {
        if (typeof input.content !== "string" || Buffer.byteLength(input.content) > editor.config.maxFileBytes) return;
        observation.expectedDigest = digest(input.content);
      } else if (kind === "edit" && buffer) {
        // Predict the built-in edit's bytes with in-memory I/O, without replacing the tool or duplicating its matching rules.
        const predictor = createEditToolDefinition(ctx.cwd, { operations: {
          access: async () => {},
          readFile: async () => buffer,
          writeFile: async (_path, content) => { observation.expectedDigest = digest(content); },
        } });
        const prepared = predictor.prepareArguments ? predictor.prepareArguments(structuredClone(input)) : input;
        await predictor.execute("range-edit-version-observer", prepared as Parameters<typeof predictor.execute>[1], undefined, undefined, ctx as ExtensionToolContext);
      }
      if (generation !== editor.generation) return;
      observations.set(event.toolCallId, observation);
      if (observations.size > 128) observations.delete(observations.keys().next().value!);
    } catch {
      // Observation must never prevent the original tool from running; uncertain changes remain unaccounted-for.
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const observation = observations.get(event.toolCallId);
    observations.delete(event.toolCallId);
    if (!observation || observation.generation !== editor.generation || event.isError || typeof event.input.path !== "string") return;
    try {
      const path = await realpath(absolutePath(event.input.path, ctx.cwd));
      if (observation.path && path !== observation.path) return;
      const current = await readTextFile(path, editor.config.maxFileBytes);
      if (observation.generation !== editor.generation) return;
      const hash = digest(current);
      if (observation.kind === "read") {
        const details = event.details as { truncation?: { firstLineExceedsLimit?: boolean } } | undefined;
        if (hash === observation.beforeDigest && !details?.truncation?.firstLineExceedsLimit && !event.content.some((item) => item.type === "image") && event.content.some((item) => item.type === "text" && item.text.length > 0)) editor.recordRead(path, hash);
      } else if (hash === observation.expectedDigest) {
        editor.recordKnownMutation(path, observation.beforeDigest, hash, observation.kind === "write");
      }
    } catch {
      // Do not infer authorship from timestamps or from unexpected post-tool bytes.
    }
  });

  function reportMutation(result: EditResult): string | undefined {
    const bridge = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-lens:io-bridge")] as { version?: number; record?: (entry: unknown) => { mutate?: { accepted: boolean; reason?: string } } } | undefined;
    if (bridge?.version !== 2 || typeof bridge.record !== "function") return;
    try {
      const lineCount = Math.max(1, result.after.split(/\r\n|\r|\n/).length);
      const ranges = result.ranges.map((range) => [Math.min(range.newStart, lineCount), Math.min(Math.max(range.newStart, range.newEnd), lineCount)]);
      const outcome = bridge.record({ filePath: result.path, consumer: "range_edit", mutate: { kind: "edit", ranges, importsChanged: true } });
      if (!outcome.mutate?.accepted) return `pi-lens mutation reporting was not accepted (${outcome.mutate?.reason ?? "unknown reason"}).`;
    } catch (error) {
      return `pi-lens mutation reporting failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  pi.registerTool({
    name: "range_edit",
    label: "Range edit",
    description: "Efficiently edit whole lines and blocks using line numbers and exact boundary text. Use ordinary 1-based coordinates without repeating the old interior. End is inclusive; omit end for one line. Searches within a bounded radius using the SAME offset for both boundaries; rejects missing/ambiguous matches and overlapping edits. All edits resolve against one original file. Normal read/read_symbol/read_enclosing establish digest-only version tracking; recorded range/edit/write mutations can chain without rereading. Unaccounted-for changes or an unverified file return a proposed diff and pendingId without writing. Review current code/diff, then action=reapply with only pendingId to acknowledge that exact version; further changes require a fresh acknowledgement. No file snapshots, hashed line labels, or tool overrides.",
    promptSnippet: "Efficiently edit whole lines and blocks using line numbers and exact boundary text.",
    promptGuidelines: [
      "Prefer range_edit for whole-line/block replacements in existing files; use edit for substring replacements and write for new files or complete rewrites.",
      "Use exact single-line boundary text, including indentation. Review the diff/current code before reapplying a warning; never treat reapply as an automatic retry.",
      "Batch disjoint same-file ranges in one call against original coordinates. Missing/ambiguous boundaries require a reread or more distinctive boundaries, not acknowledgement.",
    ],
    parameters,
    outputSchema: Type.Object({
      status: Type.Union([Type.Literal("applied"), Type.Literal("pending"), Type.Literal("unchanged")]),
      path: Type.String(),
      pendingId: Type.Optional(Type.String()),
      summary: Type.String(),
      diff: Type.String(),
      diffTruncated: Type.Boolean(),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async execute(_callId, params, signal, _onUpdate, ctx) {
      let result: EditResult;
      if (params.action === "reapply") {
        if (!params.pendingId || params.path !== undefined || params.edits !== undefined || params.maxLineShift !== undefined) throw new Error("Reapply requires only action and pendingId, with no new edit instructions.");
        result = await editor.reapply(params.pendingId, signal);
      } else {
        if (params.pendingId !== undefined || !params.path || !params.edits) throw new Error("Edit requires path and edits; pendingId is only for reapply.");
        result = await editor.edit({ path: params.path, edits: params.edits as RangeEdit[], maxLineShift: params.maxLineShift }, ctx.cwd, signal);
      }
      const { diff } = generateDiffString(result.before, result.after);
      const patch = generateUnifiedPatch(result.path, result.before, result.after);
      const lines = diff.split("\n");
      const additions = lines.filter((line) => line.startsWith("+")).length;
      const deletions = lines.filter((line) => line.startsWith("-")).length;
      const relocated = result.ranges.filter((range) => range.shift !== 0);
      const signed = (offset: number) => `${offset > 0 ? "+" : ""}${offset}`;
      let summary: string;
      if (result.status === "pending") {
        summary = `${result.reason} Nothing written. Pending edit: ${result.pendingId}. Review the diff/current code, then call range_edit with action: reapply and this pendingId.`;
      } else if (result.status === "unchanged") {
        summary = "No changes.";
      } else {
        summary = result.ranges.length === 1 && relocated.length
          ? `Success with ${signed(relocated[0].shift)} line offset.`
          : "Success.";
        summary += ` +${additions} -${deletions} lines.`;
      }
      if (relocated.length && !(result.status === "applied" && result.ranges.length === 1)) {
        summary += ` ${relocated.map((range) => `Range ${range.editIndex + 1} offset ${signed(range.shift)}`).join("; ")}.`;
      }
      if (result.status === "applied") {
        const warning = reportMutation(result);
        if (warning) summary += `\nWarning: ${warning}`;
      }
      const shown = truncateHead(diff, { maxLines: 200, maxBytes: 12000 });
      const review = result.status === "pending";
      const text = `${summary}${review && diff ? `\n\n${shown.content}` : ""}${review && shown.truncated ? "\n[Diff truncated. Read the affected file ranges before proceeding.]" : ""}`;
      return {
        content: [{ type: "text", text }],
        isError: review,
        structuredContent: { status: result.status, path: result.path, summary, diff: shown.content, diffTruncated: shown.truncated, ...(result.pendingId ? { pendingId: result.pendingId } : {}) },
        details: { status: result.status, path: result.path, pendingId: result.pendingId, summary, diff, patch, ranges: result.ranges, ownEdits: result.ownEdits, additions, deletions } satisfies Details,
      };
    },
    renderCall(args, theme) {
      const target = args.action === "reapply" ? theme.fg("muted", " reapply ") + theme.fg("accent", args.pendingId ?? "...") : ` ${theme.fg("accent", args.path ?? "...")}`;
      return new Text(theme.fg("toolTitle", theme.bold("range_edit")) + target, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as Details | undefined;
      if (typeof details?.summary !== "string") return new Text(theme.fg("error", result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n")), 0, 0);
      const lines = details.summary.split("\n").map((line) => theme.fg(details.status === "pending" || line.startsWith("Warning:") ? "warning" : "toolOutput", line));
      if (expanded) {
        lines.push(theme.fg("accent", details.path));
        if (details.ownEdits) lines.push(theme.fg("muted", `${details.ownEdits} recorded tool edit(s) since the last read/acknowledgement.`));
        for (const range of details.ranges) lines.push(theme.fg("muted", `Range ${range.editIndex + 1}: requested ${range.requestedStart}–${range.requestedEnd}; resolved ${range.start}–${range.end}; replacement ${range.newEnd < range.newStart ? "deleted" : `${range.newStart}–${range.newEnd}`}.`));
      }
      if (details.diff) {
        const shown = truncateHead(details.diff, { maxLines: expanded ? 500 : 200, maxBytes: expanded ? 30000 : 12000 });
        lines.push("", renderDiff(shown.content, { filePath: details.path }));
        if (shown.truncated) lines.push(theme.fg("warning", expanded ? "[Diff truncated. Read the affected file ranges.]" : "[Diff truncated. Expand for more. Read the affected file ranges if still truncated.]"));
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
