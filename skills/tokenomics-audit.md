---
name: tokenomics-audit
description: Once a month, re-underwrite the whole thesis - how value reaches the token, what dilutes it, and whether the model's structure still fits - and propose structural changes where it does not.
run_types: [deep]
---
A deep run steps back from the weekly question (what moved) to the monthly one: if you were initiating coverage today, would you build this model with these assumptions?

Work through the claim the token has on the business:

- Capture. For each holder flow: what rule routes revenue to holders, who controls that rule, and what has the realized capture rate been over the trailing window compared with the terminal rate you assume? A discretionary flow that has been shrinking is telling you something about the discount premium as well as the capture rate.
- Dilution. Read the emission schedule and any scheduled unlocks against what was announced. An announced cut that has not shown up on-chain by its date is news. Net inflation (emissions minus burns, in tokens) is the number that matters to a holder.
- Staking and locking. Shifts in the staked and locked ratios change the total-return track and say something about holder conviction; they do not change the price target.
- The modules and their weights. Dispersion between the estimates is a signal in its own right. When the cash-flow estimate and the revenue-multiple estimate disagree widely, ask which one the evidence of the last month supports. Changing weights, enabling or disabling a module, or changing scenario probabilities is the user's decision: propose it, with the computed effect, only when you can argue it from evidence rather than from the target you would prefer.
- The bounds and your bands. If an assumption has been pinned at the edge of its band for several runs, either the band is wrong or you are. Say which you think, and propose a band change if it is the band.

Read back through the journal (get_journal pages further than the context pack). Which open questions got answered? Which calls were wrong, and what did they have in common?

A deep run should leave the thesis restated in the journal in a form the user could read cold: what the token's claim is, what it is worth under each scenario and why, and the two or three things most likely to change that.
