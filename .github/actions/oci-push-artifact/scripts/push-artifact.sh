#!/usr/bin/env bash
#
# Publishes a single file to an OCI registry as a typed artifact using
# ORAS, then applies additional tags to the same manifest.
# Registry-agnostic (GHCR, ACR, ECR, Docker Hub) — the registry host is
# derived from the image reference.
#
# Inputs arrive as environment variables, set by action.yml:
#   FILE
#   IMAGE_INPUT
#   ARTIFACT_TYPE
#   MEDIA_TYPE
#   TAGS_INPUT
#   REGISTRY_USER
#   REGISTRY_PASSWORD
#   ANNOTATIONS
#
# Outputs are written to $GITHUB_OUTPUT.

set -euo pipefail

# Fail with one clear message rather than N confusing ones downstream.
require() {
  local tool="$1" hint="$2"
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "::error title=${tool} missing::${hint}"
    exit 1
  fi
}
require oras "Install ORAS before this action (oras-project/setup-oras)"
echo "::add-mask::${REGISTRY_PASSWORD}"

if [[ ! -s "$FILE" ]]; then
  echo "::error title=OCI push::${FILE} is missing or empty"
  exit 1
fi

IMAGE="${IMAGE_INPUT,,}"
REGISTRY="${IMAGE%%/*}"

read -r -a TAGS <<< "$(printf '%s' "$TAGS_INPUT" | tr '\n' ' ')"
if [[ "${#TAGS[@]}" -eq 0 ]]; then
  echo "::error title=OCI push::No tags supplied"
  exit 1
fi
PRIMARY="${TAGS[0]}"

ANNOTATION_ARGS=()
if [[ -n "$ANNOTATIONS" ]]; then
  while IFS= read -r annotation; do
    if [[ -n "${annotation//[[:space:]]/}" ]]; then
      ANNOTATION_ARGS+=(--annotation "$annotation")
    fi
  done <<< "$ANNOTATIONS"
fi

echo "::group::oras login ${REGISTRY}"
printf '%s' "$REGISTRY_PASSWORD" | oras login "$REGISTRY" -u "$REGISTRY_USER" --password-stdin
echo "::endgroup::"

FILE_DIR="$(dirname "$FILE")"
FILE_NAME="$(basename "$FILE")"

echo "::group::oras push ${IMAGE}:${PRIMARY}"
PUSH_LOG="$(mktemp)"
(
  cd "$FILE_DIR"
  oras push "${IMAGE}:${PRIMARY}" \
    --artifact-type "$ARTIFACT_TYPE" \
    "${ANNOTATION_ARGS[@]}" \
    "${FILE_NAME}:${MEDIA_TYPE}"
) | tee "$PUSH_LOG"
echo "::endgroup::"

DIGEST="$(grep -oE 'sha256:[0-9a-f]{64}' "$PUSH_LOG" | tail -n1 || true)"

if [[ "${#TAGS[@]}" -gt 1 ]]; then
  echo "::group::oras tag (${#TAGS[@]} tags)"
  oras tag "${IMAGE}:${PRIMARY}" "${TAGS[@]:1}"
  echo "::endgroup::"
fi

{
  echo "reference=${IMAGE}:${PRIMARY}"
  echo "digest=${DIGEST}"
  echo "tags=${TAGS[*]}"
} >> "$GITHUB_OUTPUT"
echo "::notice title=OCI push::${IMAGE} tags=${TAGS[*]} digest=${DIGEST:-unknown}"
