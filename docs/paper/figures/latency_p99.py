#!/usr/bin/env python3
"""
latency_p99.py — p99 end-to-end slot-read latency, Modal vs K8s.

Reads daily rollups from ../data/phase1/*.json; falls back to synthetic
data when none exist.
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
OUT_PDF = HERE / "latency_p99.pdf"

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
                "modal": r.get("p99_ms_modal", np.nan),
                "k8s": r.get("p99_ms_k8s", np.nan),
            }
        )
    return pd.DataFrame(rows).sort_values("date").reset_index(drop=True)


def load_synthetic() -> pd.DataFrame:
    rng = np.random.default_rng(seed=20260418)
    dates = pd.date_range("2026-04-17", periods=28, freq="D")
    # Modal cold-start penalties push p99 higher and noisier.
    modal = rng.normal(loc=1850, scale=180, size=28).clip(min=400)
    # K8s warm, L1+L2 cache coherent; lower steady-state p99.
    k8s = rng.normal(loc=1420, scale=90, size=28).clip(min=400)
    return pd.DataFrame({"date": dates, "modal": modal, "k8s": k8s})


def main() -> int:
    df = load_real()
    synthetic = df is None
    if synthetic:
        print("[latency_p99] no real data; using synthetic fallback.",
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
    ax.set_ylabel("p99 slot-read latency (ms)")
    ax.set_title("p99 slot-read latency"
                 + (" [synthetic]" if synthetic else ""))
    ax.legend(loc="best", frameon=False, fontsize=7)
    ax.tick_params(axis="x", labelrotation=30, labelsize=7)
    ax.tick_params(axis="y", labelsize=7)
    fig.savefig(OUT_PDF, dpi=DPI, format="pdf")
    print(f"[latency_p99] wrote {OUT_PDF}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
