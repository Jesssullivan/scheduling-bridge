#!/usr/bin/env node
/**
 * HMR-style LaTeX build watcher for the acuity-middleware paper.
 *
 * Usage:  node docs/paper/watch.mjs          (or: npm run paper:dev)
 * Requires: tectonic (brew install tectonic)
 *
 * Watches .tex and .bib files in docs/paper/, rebuilds on change,
 * and opens the PDF on first successful build (macOS `open`).
 */

import { watch, existsSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAPER_DIR = __dirname;
const TEX_FILE = "acuity-middleware-paper.tex";
const PDF_FILE = "acuity-middleware-paper.pdf";
const DEBOUNCE_MS = 400;

// ── preflight ───────────────────────────────────────────────
try {
  execSync("tectonic --version", { stdio: "pipe" });
} catch {
  console.error(
    "\x1b[31m✗ tectonic not found.\x1b[0m  Install it:\n\n" +
      "  brew install tectonic\n"
  );
  process.exit(1);
}

// ── build ───────────────────────────────────────────────────
let building = false;
let queued = false;
let opened = false;

function build() {
  if (building) {
    queued = true;
    return;
  }
  building = true;
  const start = Date.now();
  console.log(`\x1b[36m⟳ building…\x1b[0m`);

  const proc = spawn("tectonic", [TEX_FILE], {
    cwd: PAPER_DIR,
    stdio: "pipe",
  });

  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));

  proc.on("close", (code) => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (code === 0) {
      console.log(`\x1b[32m✓ built in ${elapsed}s\x1b[0m  → ${PDF_FILE}`);
      if (!opened) {
        opened = true;
        // open PDF in default viewer (macOS); non-fatal if it fails
        try {
          execSync(`open "${resolve(PAPER_DIR, PDF_FILE)}"`, {
            stdio: "ignore",
          });
        } catch {}
      }
    } else {
      console.log(`\x1b[31m✗ build failed (${elapsed}s)\x1b[0m`);
      // show last meaningful lines from tectonic stderr
      const lines = stderr.trim().split("\n");
      const errors = lines.filter(
        (l) => l.includes("error") || l.includes("!")
      );
      console.log(
        errors.length ? errors.join("\n") : lines.slice(-8).join("\n")
      );
    }

    building = false;
    if (queued) {
      queued = false;
      build();
    }
  });
}

// ── watch ───────────────────────────────────────────────────
let timer = null;

function onFileChange(_event, filename) {
  if (!filename) return;
  if (!/\.(tex|bib|sty|cls|bst)$/.test(filename)) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`\x1b[33m△ ${filename} changed\x1b[0m`);
    build();
  }, DEBOUNCE_MS);
}

watch(PAPER_DIR, { recursive: false }, onFileChange);

console.log(
  `\x1b[1mwatching docs/paper/ for .tex/.bib changes\x1b[0m  (ctrl-c to stop)\n`
);

// initial build
build();
