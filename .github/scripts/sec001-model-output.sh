#!/usr/bin/env bash
# Validate untrusted model-generated text and approval decisions at the
# provider-only/publish boundary. This helper is installed root-owned before
# use; it never runs model or repository code.
set -euo pipefail

command_name="${1:-}"
case "$command_name" in
  approval|text|triage)
    FILE="${2:-}"
    OUTPUT="${3:-}"
    [ -n "$FILE" ] || { echo 'missing model output file' >&2; exit 2; }
    [ -x /usr/bin/python3 ] || { echo 'python3 is required' >&2; exit 1; }
    exec /usr/bin/python3 -I - "$command_name" "$FILE" "$OUTPUT" <<'PY'
import json
import os
import stat
import sys
import unicodedata

command, path, output = sys.argv[1:]
MAX_APPROVAL_BYTES = 64 * 1024
MAX_MODEL_OUTPUT_BYTES = 256 * 1024
MAX_TEXT_BYTES = 1024 * 1024
MAX_TEXT_LINES = 2000
MAX_REASON_CHARS = 2000


def fail(message: str) -> None:
    print(f"SEC-001 model output: {message}", file=sys.stderr)
    raise SystemExit(1)


def open_nofollow(path: str, flags: int, mode: int = 0o600) -> int:
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        fail("nofollow directory support is unavailable")
    parent, name = os.path.split(path)
    if not name:
        fail("output path has no basename")
    parent_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    try:
        parent_fd = os.open(parent or ".", parent_flags)
    except OSError:
        fail("output parent is unavailable or is a symlink")
    try:
        return os.open(name, flags | os.O_NOFOLLOW, mode, dir_fd=parent_fd)
    except OSError:
        fail("output path is unavailable or is a symlink")
    finally:
        os.close(parent_fd)


def read_bounded(limit: int) -> bytes:
    flags = os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = open_nofollow(path, flags)
    except OSError:
        fail("output is unavailable or is a symlink")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            fail("output must be a regular, single-link file")
        if info.st_size > limit:
            fail("output exceeds byte limit")
        chunks = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(fd, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > limit:
            fail("output exceeds byte limit")
        return data
    except OSError:
        fail("output could not be read")
    finally:
        os.close(fd)


def write_output(data: bytes) -> None:
    if not output:
        return
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = open_nofollow(output, flags)
    except OSError:
        fail("output destination exists or is unsafe")
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                fail("output destination made no progress")
            view = view[written:]
        os.fsync(fd)
    except OSError:
        fail("output destination could not be written")
    finally:
        os.close(fd)


def read_stdin_bounded(limit: int) -> bytes:
    chunks = []
    remaining = limit + 1
    while remaining:
        chunk = os.read(0, min(1024 * 1024, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    data = b"".join(chunks)
    if len(data) > limit:
        fail("output exceeds byte limit")
    return data


def decode_utf8(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        fail("output is not valid UTF-8")


def reject_controls(text: str, label: str) -> None:
    for char in text:
        if char in "\n\r\t":
            continue
        if unicodedata.category(char).startswith("C"):
            fail(f"{label} contains a prohibited control or format character")


def validate_text(text: str) -> None:
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        fail("text exceeds byte limit")
    line_count = len(text.splitlines())
    if line_count > MAX_TEXT_LINES:
        fail("text exceeds line limit")
    reject_controls(text, "text")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _reject_constant():
    raise ValueError("non-finite number")


def parse_approval(data: bytes) -> dict:
    text = decode_utf8(data)
    # Validate before strip(): Python treats several C0/C1 controls as
    # whitespace, which must not make a decision line acceptable.
    reject_controls(text, "approval output")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        fail("approval output is empty")
    decision = lines[-1]
    if len(decision.encode("utf-8")) > MAX_APPROVAL_BYTES:
        fail("approval decision exceeds byte limit")
    try:
        value = json.loads(decision, object_pairs_hook=_unique_object, parse_constant=lambda _: _reject_constant())
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
    if value["approved"] and value["confidence"] != "high":
        fail("approved decisions require high confidence")
    if not value["approved"] and value["confidence"] != "low":
        fail("rejected decisions require low confidence")
    if not isinstance(value["reason"], str) or not value["reason"] or len(value["reason"]) > MAX_REASON_CHARS:
        fail("reason must be a bounded non-empty string")
    reject_controls(value["reason"], "reason")
    return value


if command == "text":
    data = read_bounded(MAX_TEXT_BYTES)
    validate_text(decode_utf8(data))
    if output:
        write_output(data)
    else:
        sys.stdout.buffer.write(data)
elif command == "triage":
    data = read_bounded(MAX_TEXT_BYTES)
    text = decode_utf8(data)
    validate_text(text)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    choice = lines[-1] if lines else ""
    if choice not in {"ready", "needs_input", "spam", "unknown"}:
        fail("triage output must end with one allowed decision")
    if output:
        write_output((choice + "\n").encode("utf-8"))
    else:
        sys.stdout.buffer.write((choice + "\n").encode("utf-8"))
else:
    value = parse_approval(read_bounded(MAX_MODEL_OUTPUT_BYTES))
    canonical = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    if output:
        write_output(canonical)
    else:
        sys.stdout.buffer.write(canonical)
PY
    ;;
  write)
    OUTPUT="${2:-}"
    [ -n "$OUTPUT" ] || { echo 'missing write destination' >&2; exit 2; }
    [ -x /usr/bin/python3 ] || { echo 'python3 is required' >&2; exit 1; }
    exec /usr/bin/python3 -I - "$OUTPUT" <<'PY'
import os
import sys

output = sys.argv[1]
MAX_BYTES = 1024 * 1024
if not hasattr(os, "O_NOFOLLOW"):
    print("SEC-001 model output: O_NOFOLLOW is unavailable", file=sys.stderr)
    raise SystemExit(1)
chunks = []
remaining = MAX_BYTES + 1
while remaining:
    chunk = os.read(0, min(1024 * 1024, remaining))
    if not chunk:
        break
    chunks.append(chunk)
    remaining -= len(chunk)
data = b"".join(chunks)
if len(data) > MAX_BYTES:
    print("SEC-001 model output: output exceeds byte limit", file=sys.stderr)
    raise SystemExit(1)
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
parent, name = os.path.split(output)
if not name or not hasattr(os, "O_DIRECTORY"):
    print("SEC-001 model output: output path is unsafe", file=sys.stderr)
    raise SystemExit(1)
try:
    parent_fd = os.open(parent or ".", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0))
except OSError:
    print("SEC-001 model output: output parent is unavailable or is a symlink", file=sys.stderr)
    raise SystemExit(1)
try:
    fd = os.open(name, flags | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
except OSError:
    print("SEC-001 model output: output destination exists or is unsafe", file=sys.stderr)
    raise SystemExit(1)
finally:
    os.close(parent_fd)
try:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            print("SEC-001 model output: output destination made no progress", file=sys.stderr)
            raise SystemExit(1)
        view = view[written:]
    os.fsync(fd)
except OSError:
    print("SEC-001 model output: output destination could not be written", file=sys.stderr)
    raise SystemExit(1)
finally:
    os.close(fd)
PY
    ;;
  *)
    echo 'usage: sec001-model-output.sh approval FILE [OUTPUT] | text FILE [OUTPUT] | triage FILE [OUTPUT] | write OUTPUT' >&2
    exit 2
    ;;
esac
