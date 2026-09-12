# Infinity D&D5e v0.3.38

Party Supplies now preserves safe source explanations, uses conservative coverage
thresholds and carries unused fractional rations between completed runs. Daily
use previews actual charges and shortages and refuses stale inventory or rules.
Players see difficulty labels, distribution guidance and the date, duration and
selected resources of the last upkeep. Background refreshes preserve a visibly
stale snapshot, keyboard focus and scroll; permission changes clear it.

Optional interrupted-run recovery connects persisted prompts, inventory steps,
receipts and report delivery. Existing worlds keep their current v4 mode. To
opt in, back up the world and use Quartermaster → Setup & Rules → Enable recovery.
Changed rules or uncertain inventory stop for GM review. Exhaustion suggestions
in recovery mode require manual sheet review. This release does not automatically
enable recovery or consume supplies.

Before updating, back up Drakmor and close older GM tabs. Encrypted vault setup
and unlock requirements from v0.3.37 still apply. Roll back the module to v0.3.37
if necessary; if recovery was enabled, restore the pre-upgrade world backup too.

Local validation includes the full source test suite, focused supply regressions,
responsive layouts down to 320px, keyboard journeys and 108 accessibility fixtures.
Native multi-client recovery acceptance remains pending; local tests do not prove
atomic behavior under every network partition.
