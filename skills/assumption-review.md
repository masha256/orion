---
name: assumption-review
description: Review what changed in the drivers since the last run against the assumptions, and adjust within your band only where the evidence supports it.
run_types: [weekly, deep]
---
Start from the difference between the drivers now and the drivers at the previous run, and from your last journal entry's open questions. The question for each assumption is not "is this number right" but "has anything happened that should move it".

When the pack's `trigger.triggers_this_tick` is not empty, Orion's scheduled tick raised those conditions today: cover each of them in the journal, in the order given.

A useful order:

1. Read what moved: price, revenue, holder flows and capture rate, usage index, supply and emissions. Note which moves are data (a new observation) and which are just time passing.
2. For each move that matters, ask which assumption it bears on. Usage momentum and new revenue disclosures bear on rev_growth_y1. Changes in burn or buyback behaviour bear on the terminal capture rate and its ramp. A change in how the market prices comparable revenue bears on the multiples. The regime multiplier is about the market as a whole, never about this asset.
3. Use run_whatif before you change anything, to see what the change does to the targets. If a change you believe in moves the target more than the evidence seems to justify, the change is probably too large.
4. Apply changes scenario by scenario. Bear, base, and bull are different stories, not three copies of one number: evidence that the base case is tracking well is not by itself a reason to raise the bull case.

If revenue_disclosure_stale is open, the revenue level under your growth assumptions may be out of date. Look for a newer disclosure (the disclosure-research skill) before touching rev_growth_y1, growth_fade_years, or terminal_growth. If you find none, say so in the rationale of any growth change you still make, or leave growth alone.

Once you have recorded a newer revenue figure that went live in this run, resolve the revenue_disclosure_stale anomaly, citing the new observation's id: it will not close by itself, because it is keyed to the old disclosure. If your figure became a proposal instead, leave the anomaly open.

Most weeks the right number of changes is zero or one. Write the journal so that your next run can tell what you watched and what would have made you act.
