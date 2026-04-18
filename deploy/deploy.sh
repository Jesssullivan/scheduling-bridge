#!/usr/bin/env bash
# deploy.sh — Apply the scheduling bridge to a K8s cluster.
#
# Usage:
#   deploy/deploy.sh tailnet-dev              # apply tailnet-dev overlay
#   deploy/deploy.sh tailnet-dev --dry-run     # preview without applying
#   IMAGE_TAG=sha-abc1234 deploy/deploy.sh tailnet-dev
#
# Prerequisites:
#   - kubectl configured for the target cluster
#   - SOPS + age key available for secret decryption
#   - GHCR image already pushed (PR #57 → main)
set -euo pipefail

OVERLAY="${1:?Usage: deploy.sh <overlay> [--dry-run]}"
DRY_RUN="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OVERLAY_DIR="${SCRIPT_DIR}/overlays/${OVERLAY}"

if [[ ! -d "${OVERLAY_DIR}" ]]; then
  echo "Error: overlay '${OVERLAY}' not found at ${OVERLAY_DIR}" >&2
  echo "Available overlays:" >&2
  ls "${SCRIPT_DIR}/overlays/" 2>/dev/null || echo "  (none)" >&2
  exit 1
fi

# Override image tag if IMAGE_TAG is set
if [[ -n "${IMAGE_TAG:-}" ]]; then
  echo "Using image tag: ${IMAGE_TAG}"
  cd "${OVERLAY_DIR}"
  kustomize edit set image "ghcr.io/jesssullivan/acuity-middleware:${IMAGE_TAG}"
  cd - > /dev/null
fi

echo "Rendering overlay: ${OVERLAY}"
echo "---"

if [[ "${DRY_RUN}" == "--dry-run" ]]; then
  kubectl kustomize "${OVERLAY_DIR}"
  echo "---"
  echo "(dry-run — no changes applied)"
else
  kubectl apply -k "${OVERLAY_DIR}"
  echo "---"
  echo "Waiting for rollout..."
  kubectl -n scheduling-bridge rollout status deployment/scheduling-bridge --timeout=120s
  echo "Deploy complete."
fi
