# Pi Range Edit

A Pi extension adding `range_edit` alongside the existing tools. It uses ordinary line numbers and literal boundary text: no hash-labelled reads, tool overrides, retained file snapshots, or watchers.

## Install

Requires Node 22.19 or newer and Pi. Tested against **Pi 1.2.0**; older Pi releases are not supported. Pi supplies the runtime libraries, so there is no separate build or dependency installation step. pi-lens is optional, not a dependency.

```sh
pi install git:github.com/OscarCookeAbbott/pi-range-edit
```

Start a new session or run `/reload`. For a pinned release, append `@v0.4.0` to the source. Unpinned installs follow the repository's default branch when running `pi update --extensions`.

Use `pi install --local <source>` for a project-scoped installation; Pi loads it after project trust is granted. To uninstall:

```sh
pi remove git:github.com/OscarCookeAbbott/pi-range-edit
```

Do not also keep a copied version under `~/.pi/agent/extensions/`: it would register the same tool twice. This package is distributed through Git; it is not published to npm yet.

## Replace a range

Read the file normally, then provide its first/last boundary lines and only the replacement:

```json
{
  "path": "src/example.ts",
  "edits": [{
    "start": { "line": 120, "text": "function processItems(items) {" },
    "end": { "line": 145, "text": "}" },
    "newText": "function processItems(items) {\n  return items.length;\n}"
  }]
}
```

- `action` defaults to `edit`.
- Lines are **1-based and inclusive**. Both boundary lines are replaced.
- Omit `end` for a single-line replacement. `newText: ""` deletes whole lines.
- Boundary text must match exactly, including indentation, without a newline. A leading file BOM is not part of the first boundary line.
- Start candidates are searched within ±20 lines by default. The end must match at **the same displacement**, preserving the expected range length. The end is never independently searched.
- A unique pair is required, even if one of several pairs is at the requested coordinates. No nearest-match or approximate-content guessing.
- Failures distinguish missing starts from ends that do not match at the required offset. Diagnostic lists show at most five examples, with the full count when more exist.
- Up to 32 disjoint edits resolve against the same original file. Missing/ambiguous boundaries, invalid ranges, and overlaps reject the batch before writing.
- Optional per-call `maxLineShift` can narrow the configured radius. `0` explicitly requires exact current coordinates, useful for intentional edits to repetitive lines.
- Successful results report actual diff line counts, e.g. `Success. +40 -20 lines.` A single relocated range reports `Success with +4 line offset. +40 -20 lines.` Batches identify only relocated ranges by number and signed offset. Identical output reports `No changes.` The TUI uses Pi's built-in coloured diff renderer, with a bold tool name and accented path. Normal results show up to 200 diff lines/12 KB without adding them to model context; expanding adds full coordinates, recorded-edit counts, and up to 500 lines/30 KB.
- Replacement EOLs use the first affected line's style (or the file's first EOL). A nonempty replacement inherits the replaced range's terminating newline if omitted; an explicit trailing newline at an unterminated EOF is honoured. Untouched bytes, BOM, and existing file permissions are preserved.

Use ordinary `edit` for substring changes. To insert with `range_edit`, replace a single boundary line with that line plus the inserted text; there is no separate insertion mode.

## Unexpected changes and reapply

The extension keeps a session-local **digest-only version ledger**. A stable successful `read`, `read_symbol`, or `read_enclosing` establishes a whole-file fingerprint. Own `range_edit` operations update the expected fingerprint, allowing chained edits without rereading. Known edits since the last read/acknowledgement are recorded in result details, not blocked merely for being edits.

Standard `edit` and `write` are observed without replacing them:

- Partial edit predictions reuse Pi's built-in edit implementation with in-memory I/O. The intended digest is credited only if the actual result matches **and** the pre-edit digest was already trusted.
- A successful full write can establish a version because its entire intended content was supplied by the agent.
- Failed tools, unstable reads, unexpected post-tool bytes, or unrecognised editing variants do not gain version credit.
- Bash writes, formatters, autofixes, other processes, and untracked tools may produce **unaccounted-for changes**. That wording is deliberate: the extension cannot reliably identify which process wrote a file.

If the current digest differs from the expected one, or no version was recorded, the tool returns a warning, a proposed diff, and `pendingId`. **Nothing is written.** Review the diff/current code, then acknowledge the particular proposal:

```json
{
  "action": "reapply",
  "pendingId": "<ID returned by the warning>"
}
```

Reapply is a **tool action**, not a slash command. Programmatic callers receive structured status, summary, bounded diff/truncation flag, and optional `pendingId`, including for warnings. It takes no new path, boundaries, or replacement text. The proposal binds the canonical file identity, original edit instructions/search radius, and current content digest. If the file changed again, a fresh proposal/ID is returned without writing; if boundaries no longer resolve safely, the tool refuses. Symlink retargeting also refuses. Acknowledgement bypasses only the version warning, never matching/batch validation.

Alternatively, read the current file and submit a new edit. Proposal IDs are two-character base-62 handles, unique only among currently retained proposals. The cache keeps the last 10 proposals by default, evicting the oldest at capacity. Entries are consumed after application and cleared on session start/reload, `/tree` navigation or shutdown. IDs may be reused once their entries leave the cache; they are not persistent identifiers. Always use the ID from the proposal being reviewed. Ledger entries contain digests/counts; proposals contain instructions/digests, not old file contents. Files are read transiently to match, compute replacements/diffs, and verify versions.

## Configuration

Merge into `~/.pi/agent/settings.json`, or trusted project `.pi/settings.json`:

```json
{
  "rangeEdit": {
    "maxLineShift": 20,
    "maxFileBytes": 8388608,
    "maxPendingEdits": 10
  }
}
```

Run `/reload` after changing settings. `maxLineShift` must be an integer from 0 to 1000; `maxFileBytes` a positive safe integer (default 8 MiB, for both original and resulting files). `maxPendingEdits` must be an integer from 1 to 3,844 (default 10). Invalid configuration warns and uses defaults. The tool supports existing UTF-8 regular files without NUL bytes. Replacement output must meet the same text constraint; NUL bytes and malformed Unicode are rejected before writing or creating a pending proposal. Use `write` for new/empty-file creation.

## Safety boundaries

- A digest warning concerns the **whole file**, even if changes occurred outside the target range. The proposed diff compares current contents with the replacement, not current contents with the last read: a digest alone cannot reconstruct prior code. Deliberate acknowledgement accepts that current version; it is not proof that an interior change is safe to overwrite. Never automatically retry warnings with reapply.
- Version fingerprints do not establish that every line was read. Partial reads still require appropriate content review. This extension does not reproduce pi-lens's native edit preflight/read-coverage guard.
- Same-file Pi mutations use the shared `withFileMutationQueue`. Content and symlink identity are checked again before writing. This is not an OS-level lock or compare-and-swap: an uncooperative external writer can still race the final check/write. Disk-write failures can partially affect a file, as with ordinary in-place writes. Batch atomicity means all validation precedes the single write, not crash-safe filesystem transactions.
- Digests are computed from intended output, never blindly re-stamped from unexpected post-edit disk bytes. Later drift therefore remains detectable. Observing standard tools is best-effort; unsupported/unattributable cases require a read or acknowledgement.
- With pi-lens's v2 I/O bridge present, applied mutations are reported for diagnostics, formatting, and change tracking. Proposed/refused edits are not reported as mutations. A reporting failure is a warning on an **already applied** edit, not a false claim that nothing changed. Formatting/autofix can subsequently change the file and trigger a version warning.
- Review-required warnings include model-facing diffs bounded to 200 lines/12 KB. Successful edits omit diff bodies from model context; expanded UI results show up to 500 lines/30 KB. Read the affected ranges when a diff is truncated. Full diff/patch details remain attached to the tool result; no plain-text snapshots are retained in the version ledger.

## Development

From the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

Tests use the pinned local Pi development dependencies, not a global executable. After dependency installation, they need no models, credentials, or network and use isolated temporary files. CI runs on Node 22.19 and 24.

The suite covers bounded relocation, ambiguity, atomic validation, Unicode/endings, version drift, bound reapply, cancellation/session fences, symlinks, conservative native-tool observation, same-file queuing, and the pi-lens reporting seam. The pi-lens bridge is tested at its reporting boundary; pi-lens itself is not required or loaded by the tests.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and release guidance, and [CHANGELOG.md](CHANGELOG.md) for releases.

## Licence

[MIT](LICENSE).
