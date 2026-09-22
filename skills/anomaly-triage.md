---
name: anomaly-triage
description: Work out what an anomaly means, resolve it when its cause is gone, and otherwise tell the user what you found and what you propose.
run_types: [triage]
---
A triage run has a target: an anomaly, a note from the user, or the triggers Orion's scheduled tick raised. The note is a lead. Verify it by research before you rely on any of it.

When the pack's `trigger.triggers_this_tick` is not empty, the run was launched automatically and those entries are the target. Each names a kind, the key it fired on, and Orion's own numbers in `detail`: `open_anomaly` (an anomaly opened; its id is the key), `staleness` (a critical metric is past its staleness window; research a newer figure), `driver_deviation` (revenue has drifted further from the base scenario's implied path than the threshold; `detail` gives the anchor, the implied and actual values, and the deviation), `provisional` (the user entered a provisional observation; verify it), `calendar` (a dated event has arrived; check whether it happened as described). Take them in the order given, and say in the journal what each one turned out to be.

For an anomaly, first work out which kind of problem it is:

- The data is wrong. A source is returning a bad value, or a sender that should be counted is not on the allowlist. The fix is usually in the asset config (a tolerance, a source, an allowlist), which means a config proposal with the evidence laid out.
- The data is right and the sources simply differ. One source lags, or defines the metric differently. If the disagreement is understood and will persist, the honest outcome is a proposal to acknowledge it, saying why it is safe to live with. Resolving it would only make it reopen at the next fetch.
- The condition has passed. The sources agree again, or the failing source is back. Resolve it, citing the observation that shows it.
- You cannot tell. Say what you checked and what you would need to know. Leave it open.

Read the anomaly's detail: it carries both readings and when each was seen. get_observations on the metric shows what the primary source has been reporting. An anomaly whose occurrences keep rising is a standing condition, not a blip.

A degrading anomaly blocks assumption changes for the asset, on purpose. Do not rush to resolve one just to unblock yourself. If the data cannot be trusted, the right amount of assumption maintenance is none.

If the user acknowledged an anomaly earlier and its reading has since grown, that is worth a line in the journal and, if it now matters, a proposal to withdraw the acknowledgement.
