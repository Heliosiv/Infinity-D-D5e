# Infinity D&D5e v0.3.45

This update makes guided downtime easier to correct while preserving already
recorded work and rewards.

## What changed

- A four-hour block accepts activities and projects whose saved time requirement
  fits. Longer choices are shown as unavailable before the block opens.
- Reviewing one character no longer stops other unresolved characters from
  submitting or recalling their choices. The roll being reviewed stays fixed.
- Before any result is applied, the GM can edit the block's hours and available
  activities or add characters. Saved choices must still fit the revised block.
- The GM can adjust an unresolved character's hours, return that character for
  a fresh choice and roll, or remove them. Returning a character under review
  archives that prepared review and reopens the block.
- A completed block can be reopened for corrections when it is the latest block
  and no other block is active. Applied simple coin or project results can be
  reversed after the current wallet and cumulative project progress match the
  saved result. Reversal archives the original plan and receipt and returns the
  character for a new choice. An interrupted reversal can be retried safely.

## Upgrade check

Create a Forge Save Point before installing. After restarting the target world,
confirm Infinity D&D5e v0.3.45 is active. Open a four-hour guided block and
check the available activities. Review one submitted character while another
submits or recalls. Try correcting an unresolved character and editing the
block before applying a result. For an applied simple coin or project result,
use **Reverse applied result** only after reviewing its displayed changes.
Results involving items, benefits, injuries, hunting, or private research
require GM effect review and cannot be reversed automatically. Reinstalling an
older module does not undo changes already made to campaign data.
