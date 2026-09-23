---
name: bootstrap-research
description: On a new asset, populate every manually maintained metric from citable sources so the user can confirm the asset into life; change nothing else.
run_types: [bootstrap]
---
This asset is new. Orion has fetched what its sources publish; everything else is empty, there is no assumption set yet, and the signal is blocked until the user confirms what you record. Your only job is to fill the manual metrics with figures the user can check.

Work through them in order:

1. Work through `asset.manual_metrics` in your context pack: every metric with no source, which is everything research may write. Take the ones with no value in force first, then the required ones (the engine cannot run without them), then the critical ones, then the rest.
2. For each, find one citable primary-source figure and record it with record_provisional_observation, following the disclosure-research rules for dates and units exactly: observed_at is when the figure was true; the metric's definition decides what counts. A schedule metric takes the step in force with its effective date; an event takes each dated instance you can cite.
3. Record nothing you cannot cite from a page you fetched in this run. A figure from memory, a forum, or arithmetic over unstated inputs is not a figure.

What you do not do in this run: change an assumption (there is no set to change, and calibration is the user's, after the data exists), and propose a change to the asset config. If the asset's metric definitions look wrong for what the project publishes, say so in the journal; the user reads it before calibrating.

Finish with a journal entry that lists every manual metric as found (with the value and where), not found (with what you searched for), or ambiguous (with the candidates and why you recorded none), so the next run does not repeat the search blindly. The rows you recorded wait in the user's inbox; that is the intended path, not a failure.
