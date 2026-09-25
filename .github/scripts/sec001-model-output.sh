#!/usr/bin/env bash
# Validate untrusted model-generated text and approval decisions at the
# provider-only/publish boundary. This helper is installed root-owned before
# use; it never runs model or repository code.
set -euo pipefail

command_name="${1:-}"
FILE="${2:-}"
case "$command_name" in
  approval|text) ;;
  *) echo 'usage: sec001-model-output.sh approval FILE | text FILE' >&2; exit 2 ;;
esac
[ -n "$FILE" ] || { echo 'missing model output file' >&2; exit 2; }
[ -x /usr/bin/python3 ] || { echo 'python3 is required' >&2; exit 1; }
[ -f "$FILE" ] && [ ! -L "$FILE" ] || { echo 'model output must be a regular non-symlink file' >&2; exit 1; }

/usr/bin/python3 -I - "$command_name" "$FILE" <<'PY'
import json
import os
import stat
import sys
import unicodedata

command, path = sys.argv[1:]
MAX_APPROVAL_BYTES = 64 * 1024
MAX_MODEL_OUTPUT_BYTES = 256 * 1024
MAX_TEXT_BYTES = 1024 * 1024
MAX_TEXT_LINES = 2000
MAX_REASON_CHARS = 2000


def fail(message: str) -> None:
    print(f"SEC-001 model output: {message}", file=sys.stderr)
    raise SystemExit(1)


def read_bounded(limit: int) -> bytes:
    try:
        info = os.lstat(path)
    except OSError:
        fail("output is unavailable")
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
        fail("output must be a regular, non-symlink, single-link file")
    if info.st_size > limit:
        fail("output exceeds byte limit")
    try:
        with open(path, "rb") as handle:
            data = handle.read(limit + 1)
    except OSError:
        fail("output could not be read")
    if len(data) > limit:
        fail("output exceeds byte limit")
    return data


def decode_utf8(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        fail("output is not valid UTF-8")


def validate_text(text: str) -> None:
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        fail("text exceeds byte limit")
    line_count = text.count("\n") + (1 if text and not text.endswith("\n") else 0)
    if line_count > MAX_TEXT_LINES:
        fail("text exceeds line limit")
    for char in text:
        if char in "\n\r\t":
            continue
        if unicodedata.category(char).startswith("C"):
            fail("text contains a prohibited control or format character")


def parse_approval(data: bytes) -> dict:
    text = decode_utf8(data)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        fail("approval output is empty")
    decision = lines[-1]
    if len(decision.encode("utf-8")) > MAX_APPROVAL_BYTES:
        fail("approval decision exceeds byte limit")
    try:
        value = json.loads(decision, object_pairs_hook=lambda pairs: _unique_object(pairs), parse_constant=lambda _: _reject_constant())
    except (TypeError, ValueError, json.JSONDecodeError):
        fail("approval output is not one valid JSON object")
    if not isinstance(value, dict):
        fail("approval output must be a JSON object")
    if set(value) != {"approved", "confidence", "reason"}:
        fail("approval schema has missing or unknown fields")
    if type(value["approved"]) is not bool:
        fail("approved must be boolean")
    if value["confidence"] not in {"high", "low"}:
        fail("confidence must be high or low")
    if not isinstance(value["reason"], str) or not value["reason"] or len(value["reason"]) > MAX_REASON_CHARS:
        fail("reason must be a bounded non-empty string")
    for char in value["reason"]:
        if char in "\n\r\t":
            continue
        if unicodedata.category(char).startswith("C"):
            fail("reason contains a prohibited control or format character")
    return value


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _reject_constant():
    raise ValueError("non-finite number")


if command == "text":
    validate_text(decode_utf8(read_bounded(MAX_TEXT_BYTES)))
else:
    output = parse_approval(read_bounded(MAX_MODEL_OUTPUT_BYTES))
    print(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
PY
