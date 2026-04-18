#!/usr/bin/env python3
"""
cache_hit_ratio.py — cache hit ratio over the shadow-bake window.

Reads the daily-rollup `cache_hit_ratio` float from ../data/phase1/*.json
and plots combined (L1+L2) hit ratio over time. Falls back to synthetic
values when no rollups exist yet. The rollup schema in
`data/phase1/README.md` exposes a single `cache_hit_ratio` (not separate
L1/L2/miss), so both real and synthetic paths produce a single `hit`
series with matching shape.
"""
from __future__ import annotations

import glob
import json
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
DATA_GLOB = HERE.parent / "data" / "phase1" / "*.json"
OUT_PDF = HERE / "cache_hit_ratio.pdf"

PUB_STYLE = "seaborn-v0_8-paper"
FIGSIZE = (3.3, 2.2)
DPI = 300


def load_real() -> pd.DataFrame | None:
    files = sorted(glob.glob(str(DATA_GLOB)))
    if not files:
        return None
    rows = []
    for f in files:
        with open(f) as fh:
            r = json.load(fh)
        rows.append(
            {
                "date": pd.to_datetime(r["date"]),
                "hit": float(r.get("cache_hit_ratio", np.nan)),
            }
        )
    return pd.DataFrame(rows).sort_values("date").reset_index(drop=True)


def load_synthetic() -> pd.DataFrame:
    rng = np.random.default_rng(seed=20260419)
    dates = pd.date_range("2026-04-17", periods=28, freq="D")
    # Combined L1+L2 hit ratio (mirrors the rollup's single `cache_hit_ratio`
    # field). Target ~97% hit, ~3% upstream.
    hit = rng.normal(loc=0.97, scale=0.01, size=28).clip(0.0, 1.0)
    return pd.DataFrame({"date": dates, "hit": hit})


def main() -> int:
    df = load_real()
    synthetic = df is None
    if synthetic:
        print("[cache_hit_ratio] no real data; using synthetic fallback.",
              file=sys.stderr)
        df = load_synthetic()

    try:
        plt.style.use(PUB_STYLE)
    except OSError:
        plt.style.use("fast")

    fig, ax = plt.subplots(figsize=FIGSIZE, constrained_layout=True)
    ax.plot(df["date"], df["hit"], label="hit (L1+L2)", linewidth=1.2,
            marker="o", markersize=2.5, color="tab:green")
    ax.fill_between(df["date"], df["hit"], 1.0, alpha=0.15,
                    color="tab:red", label="upstream")
    ax.set_xlabel("Date")
    ax.set_ylabel("Fraction of requests")
    ax.set_ylim(0.0, 1.0)
    ax.set_title("Cache hit ratio"
                 + (" [synthetic]" if synthetic else ""))
    ax.legend(loc="lower right", frameon=False, fontsize=7)
    ax.tick_params(axis="x", labelrotation=30, labelsize=7)
    ax.tick_params(axis="y", labelsize=7)
    fig.savefig(OUT_PDF, dpi=DPI, format="pdf")
    print(f"[cache_hit_ratio] wrote {OUT_PDF}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
