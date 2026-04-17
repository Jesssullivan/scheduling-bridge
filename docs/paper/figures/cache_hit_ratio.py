#!/usr/bin/env python3
"""
cache_hit_ratio.py — cache hit ratio over the shadow-bake window.

Shows L1 (in-process) and L2 (Redis SETNX) hit fractions. Reads from
../data/phase1/*.json; falls back to synthetic values.
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
    # Most requests hit L1; small fraction served by L2 single-flight.
    l1 = rng.normal(loc=0.88, scale=0.02, size=28).clip(0.0, 1.0)
    l2 = rng.normal(loc=0.09, scale=0.015, size=28).clip(0.0, 1.0)
    miss = np.clip(1.0 - l1 - l2, 0.0, 1.0)
    return pd.DataFrame({"date": dates, "l1": l1, "l2": l2, "miss": miss})


def main() -> int:
    df = load_real()
    synthetic = df is None
    if synthetic or "l1" not in df.columns:
        print("[cache_hit_ratio] no real data; using synthetic fallback.",
              file=sys.stderr)
        df = load_synthetic()
        synthetic = True

    try:
        plt.style.use(PUB_STYLE)
    except OSError:
        plt.style.use("fast")

    fig, ax = plt.subplots(figsize=FIGSIZE, constrained_layout=True)
    x = np.arange(len(df))
    ax.stackplot(
        x,
        df["l1"],
        df["l2"],
        df["miss"],
        labels=["L1 (in-proc)", "L2 (Redis SETNX)", "upstream"],
        alpha=0.85,
    )
    ax.set_xlabel("Day of bake")
    ax.set_ylabel("Fraction of requests")
    ax.set_ylim(0.0, 1.0)
    ax.set_title("Cache hit ratio"
                 + (" [synthetic]" if synthetic else ""))
    ax.legend(loc="lower right", frameon=False, fontsize=7)
    ax.tick_params(axis="x", labelsize=7)
    ax.tick_params(axis="y", labelsize=7)
    fig.savefig(OUT_PDF, dpi=DPI, format="pdf")
    print(f"[cache_hit_ratio] wrote {OUT_PDF}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
