# Scheduled rituals (optional)

rstaff's autonomy is **drafts and reads, not decisions**: a scheduled run never
does anything irreversible (the autonomy levels these recipes run at are defined
in `docs/AUTONOMY.md`). Scheduling is a **documented recipe**, not hard-wired.
The engineering ritual is worth automating once the loop is in daily use; keep it
manual for the first few weeks until the output earns a cron entry.

> The company **weekly strategy review** is not an rstaff ritual — it lives in the
> separate strategy repo with its own `/weekly-review`.

## Ritual A — cockpit standup read (`/cockpit`)
A daily read of what needs you: active dispatch runs, managed-repo PRs/CI, and the
top-3 attention items. Pure read; safe to schedule.
```cron
# Weekdays 09:00 — cache a fresh cockpit render to var/cockpit-latest.md.
0 9 * * 1-5  cd /path/to/rstaff && RSTAFF_HOME=/path/to/rstaff \
  node plugins/rstaff-backlog/scripts/cockpit.js --write >> /tmp/rstaff-cockpit.log 2>&1
```

## Notes
- **`claude -p` flag names are version-sensitive** — confirm `claude --help` before
  relying on `--allowedTools` / `--permission-mode`. Keep the allowlist tight.
- The control repo is **local state**, so a local scheduler (cron/launchd) is the
  right fit today; cloud `claude` routines are a future option.
- macOS: wrap the recipe in a `launchd` agent if you want it to survive reboots.
