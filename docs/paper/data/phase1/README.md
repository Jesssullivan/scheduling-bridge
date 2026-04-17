# Phase 1.1 daily rollups

Daily rollups are written here by `parity/daily-rollup.ts` (see
`docs/superpowers/plans/2026-04-17-acuity-middleware-k8s-migration-plan.md`,
Task 20) during the four-week shadow bake. One file per UTC day, named
`YYYY-MM-DD.json`.

## Expected JSON shape

```json
{
  "date": "2026-04-17",
  "diff_counts": { "ok": 12345, "warn": 17, "critical": 0 },
  "scrape_count_modal": 612,
  "scrape_count_k8s":   618,
  "p99_ms_modal": 1850,
  "p99_ms_k8s":   1420,
  "cache_hit_ratio": 0.97,
  "notes": "optional human-readable context"
}
```

Fields are consumed by the three matplotlib scripts under
`../figures/` (`scrape_count.py`, `latency_p99.py`, `cache_hit_ratio.py`)
which regenerate the paper's PDFs. All three scripts fall back to
synthetic data when this directory is empty, so the paper builds
out of the box during scaffold validation.

This directory is tracked via `.gitkeep`; the rollup `*.json` files
themselves are committed day-by-day during the bake so evaluation is
fully reproducible from repo state at paper-submission time.
