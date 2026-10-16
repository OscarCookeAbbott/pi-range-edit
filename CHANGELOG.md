# Changelog

## 0.3.1

- Lead tool descriptions and prompt summaries with efficient whole-line/block editing, and clarify selection between range_edit, edit and write.

## 0.3.0

- Report actual added/deleted diff lines on success, with signed offsets only for relocated ranges.
- Keep successful diff bodies, full coordinates and recorded-edit counts out of model text; preserve bounded review evidence for pending proposals.
- Use Pi's built-in coloured/intra-line diff renderer and bold/accented call headers in the TUI, with richer expanded details.
- Render actual refusal text when Pi supplies empty error details instead of displaying undefined output.

## 0.2.0

- Reject NUL bytes and malformed Unicode in replacement output before writing or creating proposals.
- Distinguish missing start boundaries from end-offset mismatches; cap diagnostic examples at five with total counts.

## 0.1.0

- Initial standalone Git release of the `range_edit` tool.
- Exact line boundaries, bounded relocation, and disjoint original-coordinate batches.
- Digest-only version tracking, explicit version-bound reapply, and optional pi-lens v2 mutation reporting.
