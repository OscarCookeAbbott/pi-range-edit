export interface Boundary {
  line: number;
  text: string;
}
export interface RangeEdit {
  start: Boundary;
  end?: Boundary;
  newText: string;
}
export interface ResolvedRange {
  editIndex: number;
  requestedStart: number;
  requestedEnd: number;
  start: number;
  end: number;
  shift: number;
  newStart: number;
  newEnd: number;
}
interface Line {
  start: number;
  end: number;
  text: string;
  ending: string;
}

function linesOf(text: string, offset = 0): Line[] {
  return Array.from(text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)).flatMap((match) => {
    if (!match[0]) return [];
    const ending = /(?:\r\n|\n|\r)$/.exec(match[0])?.[0] ?? "";
    return [{ start: offset + match.index, end: offset + match.index + match[0].length, text: match[0].slice(0, match[0].length - ending.length), ending }];
  });
}

function validateBoundary(boundary: Boundary): void {
  if (!boundary || !Number.isSafeInteger(boundary.line) || boundary.line < 1 || typeof boundary.text !== "string" || /[\r\n]/.test(boundary.text)) {
    throw new Error("Boundaries require a positive 1-based line number and exact single-line text.");
  }
}

function describeMatches(starts: readonly number[], length?: number): string {
  const shown = starts.slice(0, 5).map((start) => length === undefined ? `${start + 1}` : `${start + 1}–${start + length + 1}`).join(", ");
  return shown + (starts.length > 5 ? ` (${starts.length} matches; first 5 shown)` : "");
}

export function planEdits(content: string, edits: readonly RangeEdit[], maxLineShift: number): { content: string; ranges: ResolvedRange[] } {
  if (!Number.isSafeInteger(maxLineShift) || maxLineShift < 0 || maxLineShift > 1000) throw new Error("maxLineShift must be an integer between 0 and 1000.");
  if (!Array.isArray(edits) || !edits.length || edits.length > 32) throw new Error("Provide between 1 and 32 edits to one file.");
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const lines = linesOf(content.slice(bom.length), bom.length);
  const replacements = edits.map((edit, editIndex) => {
    validateBoundary(edit.start);
    const end = edit.end ?? edit.start;
    validateBoundary(end);
    if (end.line < edit.start.line) throw new Error(`edits[${editIndex}]: end must not precede start.`);
    if (typeof edit.newText !== "string") throw new Error(`edits[${editIndex}]: newText is required; use an empty string to delete.`);
    const length = end.line - edit.start.line;
    const candidates: number[] = [];
    const starts: number[] = [];
    const lower = Math.max(0, edit.start.line - 1 - maxLineShift);
    const upper = Math.min(lines.length - 1, edit.start.line - 1 + maxLineShift);
    for (let start = lower; start <= upper; start++) {
      if (lines[start].text !== edit.start.text) continue;
      starts.push(start);
      if (lines[start + length]?.text === end.text) candidates.push(start);
    }
    if (candidates.length !== 1) {
      let reason: string;
      if (candidates.length) reason = `Ambiguous ranges at lines ${describeMatches(candidates, length)}`;
      else if (starts.length) reason = `No matching end boundary at +${length} lines from start matches ${describeMatches(starts)}`;
      else reason = "No matching start boundary";
      throw new Error(`edits[${editIndex}]: ${reason} within ±${maxLineShift} lines. Nothing written. Re-read or choose more distinctive boundaries; maxLineShift: 0 requires exact coordinates.`);
    }
    const start = candidates[0];
    const last = start + length;
    const ending = lines[start].ending || lines.find((line) => line.ending)?.ending || "\n";
    let replacement = edit.newText.replace(/\r\n|\r|\n/g, ending);
    if (replacement && lines[last].ending && !replacement.endsWith(ending)) replacement += ending;
    return { editIndex, start, last, from: lines[start].start, to: lines[last].end, replacement, replacementLines: linesOf(replacement).length };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < replacements.length; i++) {
    if (replacements[i].start <= replacements[i - 1].last) throw new Error(`edits[${replacements[i - 1].editIndex}] and edits[${replacements[i].editIndex}] overlap. Nothing written.`);
  }
  let delta = 0;
  const ranges = replacements.map((replacement) => {
    const edit = edits[replacement.editIndex];
    const newStart = replacement.start + 1 + delta;
    delta += replacement.replacementLines - (replacement.last - replacement.start + 1);
    return { editIndex: replacement.editIndex, requestedStart: edit.start.line, requestedEnd: (edit.end ?? edit.start).line, start: replacement.start + 1, end: replacement.last + 1, shift: replacement.start + 1 - edit.start.line, newStart, newEnd: newStart + replacement.replacementLines - 1 };
  });
  let result = content;
  for (const replacement of replacements.toReversed()) result = result.slice(0, replacement.from) + replacement.replacement + result.slice(replacement.to);
  return { content: result, ranges };
}
