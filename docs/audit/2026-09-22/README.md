# Security audit — 2026-09-22 (HEAD 9a70f3f)

Source-first security audit of the whole repository, `quick` profile (partial pass).

- `REPORT.md` — start here: summary, confirmed findings, needs-validation table, coverage.
- `FINDINGS-DETAIL.md` — full trace, bounded local reproduction and patch for each confirmed finding.
- `NEEDS-VALIDATION.md` — leads blocked on library or deployment facts, with owner-side checks. No severity.
- `findings.json` / `coverage-ledger.json` — machine-readable records (schema-validated).
- `architecture.md` — the architecture summary every hunter worked from.

Artifact paths in the ledger (`agents/<id>/artifacts/...`) refer to the audit's
working directory, which was not committed. No deployment was contacted; all
local checks ran offline in a sandbox without `node_modules`.
