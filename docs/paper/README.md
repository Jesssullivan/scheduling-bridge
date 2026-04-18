# Paper — acuity-middleware Phase 1 companion

Short (4-6pp) workshop paper describing the SETNX single-flight pattern
that preserves O(1/T) upstream scrape cost across N Kubernetes replicas
of the Acuity scheduling middleware.

## Build

```bash
# one-shot PDF (tectonic required: `brew install tectonic`)
pnpm paper:build

# dev watcher
pnpm paper:dev
```

The watcher rebuilds on change to any `.tex` / `.bib` file in this
directory.

## Figures

Three PDF figures are regenerated from `data/phase1/*.json`. When that
directory is empty (Phase 1.0 scaffold), each script falls back to
plausible synthetic data so the paper still builds end-to-end.

```bash
python3 figures/scrape_count.py
python3 figures/latency_p99.py
python3 figures/cache_hit_ratio.py
```

Dependencies: `matplotlib`, `pandas`, `numpy`. A minimal local venv:

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install matplotlib pandas numpy
```

## Target venues

Short-paper / poster tracks, in order of fit:

1. **arXiv preprint first** (`cs.DC`) — immediate, no gating, lets us
   cite the work from the live repo.
2. **HotCloud / HotOS** — short systems workshop, 5-6pp, strong fit
   for "here is a small operational insight" papers.
3. **EuroSys poster** or **SoCC short papers** — if we want a venue
   with a proceedings.

The document class is `acmart` in `sigconf` / `nonacm` mode so the
same source compiles cleanly for arXiv and for an ACM venue; to
retarget an IEEE venue swap to `\documentclass[conference]{IEEEtran}`
and adjust `\bibliographystyle` (see the top comment of the `.tex`).

## Layout

```
docs/paper/
  acuity-middleware-paper.tex   # main source (acmart, sigconf)
  refs.bib                      # primary bibliography
  watch.mjs                     # paper:dev HMR watcher
  README.md                     # this file
  figures/
    scrape_count.py             # Modal vs K8s upstream scrapes/hour
    latency_p99.py              # p99 slot-read latency
    cache_hit_ratio.py          # L1/L2/miss stack
  data/phase1/
    .gitkeep
    README.md                   # expected rollup shape
    YYYY-MM-DD.json             # committed daily during the bake
  _archive/                     # prior IEEE draft, preserved for reference
```
