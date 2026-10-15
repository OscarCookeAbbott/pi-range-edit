# Changelog

## 0.2.0

- Reject NUL bytes and malformed Unicode in replacement output before writing or creating proposals.
- Distinguish missing start boundaries from end-offset mismatches; cap diagnostic examples at five with total counts.

## 0.1.0

- Initial standalone Git release of the `range_edit` tool.
- Exact line boundaries, bounded relocation, and disjoint original-coordinate batches.
- Digest-only version tracking, explicit version-bound reapply, and optional pi-lens v2 mutation reporting.
