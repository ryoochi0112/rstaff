#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SPEC_FILE="$SCRIPT_DIR/mini-spec.md"
FIXTURE_FILE="$SCRIPT_DIR/fixture.diff"
KEY_FILE="$SCRIPT_DIR/defect-key.md"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

usage() {
  printf '%s\n' "usage: $0 --prompt <path> --out <dir> [--runs N]" >&2
  printf '%s\n' "       $0 --score --out <dir>" >&2
}

mode="run"
prompt_file=""
out_dir=""
runs=3

while (($# > 0)); do
  case "$1" in
    --prompt)
      (($# >= 2)) || { usage; exit 2; }
      prompt_file="$2"
      shift 2
      ;;
    --out)
      (($# >= 2)) || { usage; exit 2; }
      out_dir="$2"
      shift 2
      ;;
    --runs)
      (($# >= 2)) || { usage; exit 2; }
      runs="$2"
      shift 2
      ;;
    --score)
      mode="score"
      shift
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$out_dir" ]]; then
  usage
  exit 2
fi

if [[ "$mode" == "run" ]]; then
  if [[ -z "$prompt_file" || ! -f "$prompt_file" ]]; then
    printf 'prompt file does not exist: %s\n' "$prompt_file" >&2
    exit 2
  fi
  if [[ ! "$runs" =~ ^[1-9][0-9]*$ ]]; then
    printf -- '--runs must be a positive integer: %s\n' "$runs" >&2
    exit 2
  fi
else
  if [[ -n "$prompt_file" ]]; then
    printf '%s\n' '--prompt is not used with --score' >&2
    exit 2
  fi
fi

mkdir -p "$out_dir"

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/review-benchmark.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT

compose_review_prompt() {
  local source_prompt="$1"
  local composed_prompt="$2"

  {
    if [[ "$(sed -n '1p' "$source_prompt")" == "---" ]]; then
      awk '
        /^---[[:space:]]*$/ {
          delimiters++
          if (delimiters <= 2) next
        }
        delimiters >= 2 { print }
      ' "$source_prompt"
    else
      cat "$source_prompt"
    fi
    printf '\n\n%s\n\n' 'Benchmark inputs follow. Review the spec and diff below.'
    printf '%s\n\n' 'mini-spec.md (the spec):'
    cat "$SPEC_FILE"
    printf '\n%s\n\n' 'fixture.diff (the diff to review):'
    cat "$FIXTURE_FILE"
  } > "$composed_prompt"
}

run_review() {
  local composed_prompt="$1"
  local run_index="$2"
  local run_file="$out_dir/run-$run_index.md"
  local temporary_output="$temporary_dir/run-$run_index.md"
  local claude_status

  if [[ -s "$run_file" ]]; then
    return 0
  fi

  if "$CLAUDE_BIN" -p < "$composed_prompt" > "$temporary_output"; then
    mv -- "$temporary_output" "$run_file"
    return 0
  else
    claude_status=$?
    printf 'command failed (exit %s): %q -p\n' "$claude_status" "$CLAUDE_BIN" >&2
    return "$claude_status"
  fi
}

parse_judge_json() {
  node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const value = JSON.parse(input);
    const keys = Object.keys(value || {}).sort();
    if (keys.join(",") !== "found,fps") throw new Error("expected exactly found and fps");
    if (!Array.isArray(value.found) || !Number.isInteger(value.fps) || value.fps < 0) {
      throw new Error("found must be an array and fps must be a non-negative integer");
    }
    if (value.found.some((id) => typeof id !== "string" || !/^D[1-5]$/.test(id))) {
      throw new Error("found contains an unknown defect id");
    }
    process.stdout.write(JSON.stringify({ found: [...new Set(value.found)], fps: value.fps }));
  } catch (error) {
    process.exitCode = 1;
  }
});
'
}

run_judge() {
  local judge_prompt="$1"
  local raw_output
  local normalized_output
  local attempt
  local claude_status

  for attempt in 1 2; do
    if raw_output="$("$CLAUDE_BIN" -p < "$judge_prompt")"; then
      if normalized_output="$(printf '%s' "$raw_output" | parse_judge_json)"; then
        printf '%s' "$normalized_output"
        return 0
      fi
    else
      claude_status=$?
      printf 'command failed (exit %s): %q -p\n' "$claude_status" "$CLAUDE_BIN" >&2
      return "$claude_status"
    fi
  done

  printf 'judge output was not parseable strict JSON after 2 attempts\n' >&2
  return 1
}

if [[ "$mode" == "run" ]]; then
  composed_prompt="$temporary_dir/reviewer-prompt.md"
  compose_review_prompt "$prompt_file" "$composed_prompt"
  for ((run_index = 1; run_index <= runs; run_index++)); do
    run_review "$composed_prompt" "$run_index"
  done
  exit 0
fi

shopt -s nullglob
run_files=("$out_dir"/run-*.md)
max_run=0
for run_file in "${run_files[@]}"; do
  run_name="${run_file##*/}"
  run_number="${run_name#run-}"
  run_number="${run_number%.md}"
  if [[ "$run_number" =~ ^[1-9][0-9]*$ ]]; then
    numeric_run=$((10#$run_number))
    if ((numeric_run > max_run)); then
      max_run="$numeric_run"
    fi
  fi
done

if ((max_run == 0)); then
  printf 'no run-i.md files found under %s\n' "$out_dir" >&2
  exit 1
fi

judge_results=()
for ((run_index = 1; run_index <= max_run; run_index++)); do
  run_file="$out_dir/run-$run_index.md"
  if [[ ! -f "$run_file" ]]; then
    printf 'missing run file: %s\n' "$run_file" >&2
    exit 1
  fi
  judge_prompt="$temporary_dir/judge-$run_index.md"
  {
    printf '%s\n\n' 'Judge this captured review. Return STRICT JSON only, with exactly this shape: {"found":["D1"],"fps":0}.'
    printf '%s\n\n' 'Count only P0/P1 findings. found contains defect IDs whose must-report issue the review reported at P0/P1; fps counts reported P0/P1 findings matching no key entry.'
    printf '%s\n\n' 'Key file:line references are real target-file lines on the unified diff new-file side, computed from @@ hunk arithmetic; deletion-only issues use the first surviving new-file code line at the deletion hunk position.'
    printf '%s\n\n' 'defect-key.md:'
    cat "$KEY_FILE"
    printf '\n%s\n\n' "run-$run_index.md (the captured reviewer output):"
    cat "$run_file"
  } > "$judge_prompt"
  if judge_result="$(run_judge "$judge_prompt")"; then
    judge_results+=("$judge_result")
  else
    judge_status=$?
    exit "$judge_status"
  fi
done

node - "$out_dir" "${judge_results[@]}" <<'NODE'
const fs = require('node:fs');

const outDir = process.argv[2];
const runs = process.argv.slice(3).map((raw) => JSON.parse(raw));
const threshold = Math.ceil((2 * runs.length) / 3);
const ids = ['D1', 'D2', 'D3', 'D4', 'D5'];
const counts = new Map(ids.map((id) => [id, 0]));
for (const run of runs) {
  for (const id of run.found) counts.set(id, counts.get(id) + 1);
}
const score = {
  runs,
  majorityFound: ids.filter((id) => counts.get(id) >= threshold),
  fpMax: Math.max(...runs.map((run) => run.fps)),
};
fs.writeFileSync(`${outDir}/score.json`, `${JSON.stringify(score)}\n`);
NODE
