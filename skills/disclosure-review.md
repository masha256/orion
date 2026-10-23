---
name: disclosure-review
description: Read one stored issuer document (a call transcript or a post), compare every figure and dated plan in it with what Orion measures, and file what differs for the user. No direct assumption changes; value changes are proposals; figures wait for the user.
run_types: [disclosure]
---
A disclosure run has one target: the document in your context pack (`document`), something the issuer published, stored by Orion and labelled by kind. Its label says how far to trust it. A machine transcript can mishear names and numbers, and every figure in it is the speaker's dated claim, not a fact. The pack also carries `asset_config_yaml`, the asset's own config file with its comments, which says where each of Orion's numbers comes from, and `adapter_params`, the documented options each adapter accepts, which a config proposal may set.

Work through it in this order:

1. Read the document end to end before you call any tool. List every quantitative claim (revenue, fees, volumes, take rate, buyback share, bought or burned tokens, staked tokens, supply and unlock terms, revenue shares with partners) and every dated plan.
2. For each claim, find the Orion metric that measures the same thing, from `asset_config_yaml`. Say where Orion's number comes from (its source, and what that source counts), and read it for the same period: get_flow_total for the sum of a flow over whole days (it sums Orion's confirmed rows only; a flow_conflict refusal is itself a data finding worth a dev finding), get_observations for levels and single readings.
3. Classify each claim:
   - It matches Orion within the noise of the source: a line in the journal summary, nothing filed.
   - Orion can already express the correct value by config or by an assumption: a proposal with propose_change, citing the document, with the run_whatif effect in the rationale. A config proposal may use only options the asset's adapters accept (`adapter_params`). Assumption values go through propose_change too: apply_assumption_change is not available in this run.
   - It needs code or a new or different data source (a flow Orion does not measure, a source that counts something the issuer does not keep, an adapter that cannot express the stated terms): record_dev_finding, with Orion's own numbers for the same thing and period in `orion_reading` and the observations you read as evidence.
   - It is a dated plan (a filing, a launch, a mainnet, a token event): a catalyst in write_journal, dated as precisely as the document allows. "Next month" is the calendar month after the document's date. "By year end" is `by` December 31. "Up to N days after X" is `from` the start of X's window, `to` its end plus N days.
4. A claim and Orion's reading that disagree are a finding, not a correction. Say what each one measures before you say which is wrong.
5. Quote the document verbatim, errors included: if the transcript misspells a name, the quote keeps the misspelling, and your own text uses the correct name. Cite the document as `doc:<id>`; in a transcript a quote must sit within three consecutive lines. Every proposal, dev finding and catalyst from this run carries at least one citation of the document.
6. Never record an observation from a machine transcript unless the figure is also confirmed by Orion's own data or by a second source you fetched in this run. Orion sends such a figure to the user regardless: as a proposal when the metric takes provisional data, else as an inert row.
7. Finish with a journal entry that lists what you checked and found consistent, as well as what you filed, so a later run does not redo the comparison.
