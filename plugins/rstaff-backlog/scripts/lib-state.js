// rstaff engineering-state collector — Node built-ins only, zero dependencies.
// Single source of parsed truth for /cockpit. Reads the operator's control-repo
// state: managed repos (product profiles) and active /dispatch runs.
// (Company strategy lives in a separate strategy repo and is not read here.)
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require(path.join(__dirname, '..', 'hooks', 'lib.js'));
const fs = lib.fs;

// Managed repos: absolute paths from product-profile "**Repo:** `<path>`" lines
// in profiles/*.md, plus the control repo itself.
function collectRepos(home) {
  const dir = path.join(home, 'profiles');
  const repos = [{ slug: lib.slug(home), path: home, control: true }];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch (_) {}
  for (const f of files) {
    const m = lib.safeRead(path.join(dir, f), 400).match(/\*\*Repo:\*\*\s*`([^`]+)`/);
    if (m) repos.push({ slug: f.replace(/\.md$/, ''), path: m[1].trim(), control: false });
  }
  return repos;
}

// Every branch this clone still knows about, locally or from origin's last fetch.
// Local refs are the right source, not `ls-remote`: an in-flight branch is often
// not pushed yet, and `gh pr merge --delete-branch` removes the origin/* tracking
// ref when the PR lands. Never throws; null means "could not look", never "gone".
function gitRefs(repoPath) {
  if (!repoPath) return null;
  let r;
  try {
    r = spawnSync('git', ['-C', repoPath, 'for-each-ref', '--format=%(refname:short)',
      'refs/heads', 'refs/remotes/origin'], { encoding: 'utf8', timeout: 5000 });
  } catch (_) { return null; }
  if (!r || r.status !== 0) return null;
  const refs = new Set();
  for (const line of String(r.stdout).split('\n')) {
    const ref = line.trim();
    if (ref) refs.add(ref);
  }
  return refs;
}

// Status files carry prose after the ref — `feat/mcp-2x (merged, deleted)`,
// `feat/example-migration (deleted, local + remote)` — or name no ref at all:
// `(deleted — merged to main)`. Take the leading ref token; '' when the value
// names none, so an unparseable branch stays unknown rather than reading stale.
const PLACEHOLDER = new Set(['-', 'none', 'n/a', 'tbd']);
function branchRef(value) {
  const m = String(value || '').trim().match(/^[A-Za-z0-9._+\-/]+/);
  const ref = m ? m[0].replace(/[.,;:]+$/, '').replace(/^origin\//, '') : '';
  if (!ref || !ref.includes('/') || !/[A-Za-z0-9]/.test(ref) || PLACEHOLDER.has(ref.toLowerCase())) return '';
  return ref;
}

// Three-valued by construction: live === false demands positive evidence — a
// parsable ref AND a successful probe that did not contain it. A row is never
// called stale because we failed to look.
// Memoized here rather than in the probe, so the "at most one look per repo"
// bound holds for any refsFor a caller injects, and a repo whose rows name no
// ref is never probed at all.
function reconcileDispatch(rows, refsFor) {
  const seen = new Map();
  const refsOf = (repo) => {
    const key = lib.slug(repo);
    if (!seen.has(key)) seen.set(key, typeof refsFor === 'function' ? refsFor(repo) : null);
    return seen.get(key);
  };
  return rows.map((row) => {
    const ref = branchRef(row.branch);
    if (!ref) return { ...row, ref: '', live: null };
    const refs = refsOf(row.repo);
    // A ref set may name a branch either bare or as origin/<branch>; either
    // sighting vouches for it, so callers never have to pre-normalize.
    if (!refs) return { ...row, ref, live: null };
    return { ...row, ref, live: refs.has(ref) || refs.has(`origin/${ref}`) };
  });
}

// The repo to probe is the PROFILE's path, never the row's own `worktree:` —
// that field is prose in real files ("(none — branch merged and deleted)") and
// is removed precisely for the rows that most need judging. A dispatch dir with
// no matching profile yields null: unknown, never stale.
// reconcileDispatch does the caching, so this runs once per repo dir at most.
function repoRefsFor(home) {
  let byRepo = null;
  return (repo) => {
    if (!byRepo) byRepo = new Map(collectRepos(home).map((r) => [lib.slug(r.slug), r.path]));
    return gitRefs(byRepo.get(lib.slug(repo)) || null);
  };
}

// Active /dispatch runs: one status file per feature under var/dispatch/<repo>/.
// Rows are reconciled against git, because nothing writes a row back when its PR
// merges — a hand-edited `state:` is only as true as the last hand-edit.
// Pass opts.refsFor to inject the probe (null opts it out entirely, offline).
function collectDispatch(home, opts) {
  const refsFor = opts && opts.refsFor !== undefined ? opts.refsFor : repoRefsFor(home);
  const root = path.join(home, 'var', 'dispatch');
  const out = [];
  let repos = [];
  try { repos = fs.readdirSync(root); } catch (_) { return out; }
  for (const repo of repos) {
    const dir = path.join(root, repo);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch (_) { continue; }
    for (const f of files) {
      // Read the whole file, bounded the way lib-backlog bounds its parses. A small
      // cap silently drops the keys past it: at 800 a verbose `tasks:` pushed
      // `next_human_action:` out of the window, and — worse — hid the later `state:`
      // block entirely, so last-match below could never see it. A truncating parser
      // must have headroom over its largest input, not over its typical one.
      const b = lib.safeRead(path.join(dir, f), 512 * 1024);
      // Real files pack two keys onto one line — `worktree: <path>    branch: <b>`
      // and `last_commit: <sha>    updated: <iso>` — so a key is preceded by either
      // a line start or a run of spaces, and its value ends at the next such key.
      // Match [ \t]{2,}, never \s{2,}: \s eats newlines and would end a value on a
      // continuation line.
      const rx = (k, flags) => new RegExp(`(?:^|[ \\t]{2,})${k}:[ \\t]*(.*?)(?=[ \\t]{2,}[A-Za-z_][A-Za-z0-9_]*:|$)`, flags);
      const lines = b.split('\n');
      const headers = lines.filter((line) => !/^[ \t]/.test(line)).join('\n');
      const collectScalar = (k, value, occurrence) => {
        if (value !== '|' && value !== '>') return value;
        let seen = 0;
        for (let i = 0; i < lines.length; i += 1) {
          if (/^[ \t]/.test(lines[i])) continue;
          const matches = [...lines[i].matchAll(rx(k, 'g'))];
          for (const m of matches) {
            if (seen !== occurrence) {
              seen += 1;
              continue;
            }
            if (m[1].trim() !== value) return value;
            const content = [];
            for (let j = i + 1; j < lines.length && /^[ \t]/.test(lines[j]); j += 1) {
              content.push(lines[j].replace(/^[ \t]+/, '').trim());
            }
            return content.join(' ');
          }
        }
        return value;
      };
      const g = (k) => {
        const m = headers.match(rx(k, 'm'));
        return m ? collectScalar(k, m[1].trim(), 0) : '';
      };
      // `state:` is the ONE last-match key, because it is the one lifecycle field: an
      // operator who appends a `## ship`/`## withdrawn` block declares a state that
      // SUPERSEDES the earlier one, so first-match reports a run as awaiting review
      // that its own file records as finished. Every other key is an identity or
      // progress field that the append block merely restates — last-match `branch:`
      // picks the prose-laden restatement over the clean ref for no gain. Across the
      // real store only `state:` and `branch:` ever repeat, and only `state:` changes
      // meaning when it does; the rest have no second occurrence to learn from, so
      // they stay first-match rather than becoming untested behaviour.
      const gLast = (k) => {
        const ms = [...headers.matchAll(rx(k, 'gm'))];
        return ms.length ? collectScalar(k, ms[ms.length - 1][1].trim(), ms.length - 1) : '';
      };
      const state = gLast('state');
      if (!state) continue;
      out.push({ repo, slug: f.replace(/\.md$/, ''), state, tasks: g('tasks'), branch: g('branch'), updated: g('updated'), next: g('next_human_action') });
    }
  }
  return reconcileDispatch(out, refsFor);
}

function collect(home, opts) {
  return {
    home,
    repos: collectRepos(home),
    dispatch: collectDispatch(home, opts),
  };
}

module.exports = { collect, collectRepos, collectDispatch, reconcileDispatch, branchRef, gitRefs };
