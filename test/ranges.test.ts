import assert from "node:assert/strict";
import { test } from "node:test";
import { planEdits } from "../src/ranges.ts";

const block = { start: { line: 2, text: "start" }, end: { line: 4, text: "end" }, newText: "start\nnew\nend" };

test("both boundaries relocate by one shared offset, within the configured radius", () => {
  const shifted = "inserted\nheader\nstart\nold\nend\nfooter\n";
  const result = planEdits(shifted, [block], 1);
  assert.equal(result.content, "inserted\nheader\nstart\nnew\nend\nfooter\n");
  assert.equal(result.ranges[0].shift, 1);
  assert.throws(() => planEdits(shifted, [block], 0), /No matching/);
  assert.throws(() => planEdits("header\nstart\nextra\nold\nend\n", [block], 20), /No matching/);
  assert.equal(planEdits("start\nold\nend\n", [block], 1).ranges[0].shift, -1);
});

test("duplicates fail closed even when expected coordinates match; exact-coordinate mode is explicit", () => {
  const repeated = "header\nstart\nold\nend\nstart\nold\nend\n";
  assert.throws(() => planEdits(repeated, [block], 20), /Ambiguous.*2–4, 5–7/);
  assert.equal(planEdits(repeated, [block], 0).content, "header\nstart\nnew\nend\nstart\nold\nend\n");
  assert.throws(() => planEdits("header\n start\nold\nend\n", [block], 20), /No matching/);
});

test("disjoint batches use original coordinates and validate overlaps before any replacement", () => {
  const original = "one\ntwo\nthree\nfour\nfive\n";
  const result = planEdits(original, [
    { start: { line: 5, text: "five" }, newText: "" },
    { start: { line: 2, text: "two" }, newText: "two-a\ntwo-b" },
  ], 0);
  assert.equal(result.content, "one\ntwo-a\ntwo-b\nthree\nfour\n");
  assert.deepEqual(result.ranges.map(({ start, newStart, newEnd }) => ({ start, newStart, newEnd })), [
    { start: 2, newStart: 2, newEnd: 3 }, { start: 5, newStart: 6, newEnd: 5 },
  ]);
  assert.throws(() => planEdits(original, [
    { start: { line: 2, text: "two" }, end: { line: 3, text: "three" }, newText: "replacement" },
    { start: { line: 3, text: "three" }, newText: "overlap" },
  ], 0), /overlap/);
  assert.throws(() => planEdits(original, [{ start: { line: 0, text: "one" }, newText: "bad" }], 0), /1-based/);
  assert.throws(() => planEdits(original, [{ start: { line: 2, text: "two" }, end: { line: 1, text: "one" }, newText: "bad" }], 0), /precede/);
  assert.throws(() => planEdits(original, [{ start: { line: 1, text: "one\ntwo" }, newText: "bad" }], 0), /single-line/);
});

test("replacement preserves untouched Unicode/BOM/mixed endings and honours final-newline intent", () => {
  const original = "\uFEFFprefix 🐈 e\u0301\r\nstart\r\nold\nend\r\nuntouched";
  assert.equal(planEdits(original, [block], 0).content, "\uFEFFprefix 🐈 e\u0301\r\nstart\r\nnew\r\nend\r\nuntouched");
  assert.equal(planEdits("a\nb", [{ start: { line: 2, text: "b" }, newText: "c" }], 0).content, "a\nc");
  assert.equal(planEdits("a\nb", [{ start: { line: 2, text: "b" }, newText: "c\n" }], 0).content, "a\nc\n");
  assert.equal(planEdits("a\nb\n", [{ start: { line: 2, text: "b" }, newText: "" }], 0).content, "a\n");
  assert.equal(planEdits("a\rb\r", [{ start: { line: 2, text: "b" }, newText: "c" }], 0).content, "a\rc\r");
});
