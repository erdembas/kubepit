#!/usr/bin/env bash
# Keep every workspace test, bound a stalled run, and collect only process/stack
# metadata. Do not print command arguments, locals, environment or kubeconfig.
set -euo pipefail

deadline=${RUST_TEST_TIMEOUT_SECONDS:-900}
idle_limit=${RUST_TEST_IDLE_SECONDS:-120}
for value in "$deadline" "$idle_limit"; do
  if [[ ! $value =~ ^[1-9][0-9]*$ ]]; then
    echo 'Rust test diagnostic intervals must be positive whole seconds.' >&2
    exit 2
  fi
done
for tool in cargo timeout ps pgrep stat tee gdb sudo readlink date cat; do
  command -v "$tool" >/dev/null || { echo "Missing diagnostic tool: $tool" >&2; exit 2; }
done
diagnostics=${RUST_TEST_DIAGNOSTICS_DIR:-${RUNNER_TEMP:-/tmp}/kubepit-rust-diagnostics}
mkdir -p "$diagnostics"
log="$diagnostics/cargo-test.log"
: > "$log"
workspace=$(pwd -P)
# Resolve the external program Rust's Command uses, not Bash's kill builtin.
external_kill=$(type -P kill || true)
if [[ -n $external_kill ]]; then
  printf 'External kill executable: %s\n' "$external_kill"
  "$external_kill" --version 2>&1 | head -n 1 || true
fi

# GNU timeout owns a separate process group and returns nonzero on expiration.
# Preserve libtest's normal capture and the exact full serial workspace command.
timeout --signal=TERM --kill-after=10s "${deadline}s" \
  cargo test --workspace --locked -- --test-threads=1 > >(tee "$log") 2>&1 &
controller=$!
trap 'kill -TERM "$controller" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

descendants() {
  local child
  for child in $(pgrep -P "$1" || true); do
    printf '%s\n' "$child"
    descendants "$child"
  done
}

capture_diagnostics() {
  local pid executable ids
  local -a children tests=()
  mapfile -t children < <(descendants "$controller")
  ids=$(IFS=,; echo "$controller,${children[*]}")
  if [[ $metadata_captured == false ]]; then
    metadata_captured=true
    echo '::group::Rust inactivity process metadata (no arguments or environment)'
    ps -o pid,ppid,pgid,sid,stat,wchan:32,comm -p "${ids%,}" \
      > "$diagnostics/processes-inactivity.txt" || true
    cat "$diagnostics/processes-inactivity.txt"
    echo '::endgroup::'
  fi
  for pid in "${children[@]}"; do
    executable=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
    case "$executable" in
      "$workspace"/target/debug/deps/*|"$PWD"/target/debug/deps/*) tests+=("$pid") ;;
    esac
  done
  # A quiet compile must not consume the one diagnostic capture before tests
  # begin. Only collect when a test executable is actually running.
  (( ${#tests[@]} > 0 )) || return 1
  echo '::group::Rust test inactivity diagnostics (no arguments or environment)'
  ps -o pid,ppid,pgid,sid,stat,wchan:32,comm -p "${ids%,}" \
    > "$diagnostics/processes.txt" || true
  cat "$diagnostics/processes.txt"
  for pid in "${tests[@]}"; do
    # Only attach to test binaries descended from this invocation, not services
    # or compilers. GDB auto-load/config/network hooks remain disabled.
    if ! timeout --signal=TERM --kill-after=3s 20s sudo -n \
      gdb --quiet --nx --nh --batch \
      -iex 'set auto-load off' \
      -iex 'set debuginfod enabled off' \
      -iex 'set pagination off' \
      -iex 'set print frame-arguments none' \
      -iex 'set print entry-values no' \
      -ex 'thread apply all bt' -ex detach -p "$pid" \
      > "$diagnostics/stack-$pid.txt" 2>&1; then
      echo "Could not collect a complete stack for test PID $pid."
    fi
    cat "$diagnostics/stack-$pid.txt"
  done
  echo '::endgroup::'
}

captured=false
metadata_captured=false
while kill -0 "$controller" 2>/dev/null; do
  if [[ $captured == false ]] && \
    (( $(date +%s) - $(stat -c %Y "$log") >= idle_limit )); then
    if capture_diagnostics; then captured=true; fi
  fi
  sleep 1
done
status=0
wait "$controller" || status=$?
trap - EXIT INT TERM
if (( status != 0 )); then
  echo "::error::Full serial Rust tests failed or exceeded ${deadline}s (exit $status)."
fi
exit "$status"
