#!/usr/bin/env python3
"""
scrape_count.py — Modal (N=1) vs K8s (N=2) upstream scrape count per hour.

Reads daily rollups from ../data/phase1/*.json. When no rollups exist yet
(Phase 1.0 scaffold validation), falls back to plausible synthetic data so
`pnpm paper:build` works out of the box.

JSON rollup shape (one per day):
    {
      "date": "2026-04-17",
      "scrape_count_modal": <int>,
      "scrape_count_k8s":   <int>,
      ...
    }
"""
from __future__ import annotations

import glob
import json
import os
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
DATA_GLOB = HERE.parent / "data" / "phase1" / "*.json"
OUT_PDF = HERE / "scrape_count.pdf"

PUB_STYLE = "seaborn-v0_8-paper"
FIGSIZE = (3.3, 2.2)  # single-column
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
                "modal": r.get("scrape_count_modal", np.nan),
                "k8s": r.get("scrape_count_k8s", np.nan),
            }
        )
    return pd.DataFrame(rows).sort_values("date").reset_index(drop=True)


def load_synthetic() -> pd.DataFrame:
    """Plausible 28-day shadow-bake synthetic series."""
    rng = np.random.default_rng(seed=20260417)
    dates = pd.date_range("2026-04-17", periods=28, freq="D")
    # Modal N=1: ~1 scrape per TTL per hour, 24 per day, +noise.
    modal = rng.normal(loc=26, scale=3, size=28).clip(min=10)
    # K8s N=2 WITH SETNX single-flight: should track Modal closely.
    k8s = modal + rng.normal(loc=1.2, scale=1.0, size=28)
    return pd.DataFrame({"date": dates, "modal": modal, "k8s": k8s})


def main() -> int:
    df = load_real()
    synthetic = df is None
    if synthetic:
        print("[scrape_count] no real data; using synthetic fallback.",
              file=sys.stderr)
        df = load_synthetic()

    try:
        plt.style.use(PUB_STYLE)
    except OSError:
        plt.style.use("fast")

    fig, ax = plt.subplots(figsize=FIGSIZE, constrained_layout=True)
    ax.plot(df["date"], df["modal"], label="Modal (N=1)", linewidth=1.2,
            marker="o", markersize=2.5)
    ax.plot(df["date"], df["k8s"], label="K8s (N=2, SETNX)",
            linewidth=1.2, marker="s", markersize=2.5, linestyle="--")
    ax.set_xlabel("Date")
    ax.set_ylabel("Scrapes / hour (mean)")
    ax.set_title("Upstream scrape count per hour"
                 + (" [synthetic]" if synthetic else ""))
    ax.legend(loc="best", frameon=False, fontsize=7)
    ax.tick_params(axis="x", labelrotation=30, labelsize=7)
    ax.tick_params(axis="y", labelsize=7)
    fig.savefig(OUT_PDF, dpi=DPI, format="pdf")
    print(f"[scrape_count] wrote {OUT_PDF}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
