---
name: disclosure-research
description: Find and record figures that no API publishes (revenue run rate, announced emission or policy changes) from sources you can quote.
run_types: [weekly, triage, deep, bootstrap]
---
Some of the most important inputs are maintained by hand because the project publishes them only in prose: the revenue run rate above all, and announced changes to emissions, burn policy, or token terms. The context pack lists stale and provisional metrics; a manual metric that is stale, or a revenue figure that usage has moved away from, is the usual reason to research.

How to research well here:

- Search for the project's own words first: its blog, its documentation, the founders' public posts. Then reputable press that quotes them directly, with a date.
- Fetch the page you intend to cite. You can only cite a page you fetched in this run, and the quote must be the page's own words, verbatim, long enough to carry the claim (the figure and what it is a figure of). Quote from within one paragraph, table cell, or list item: a quote that runs across separate blocks of the page is refused, even if every word of it is there.
- You cannot record a figure where an observation already exists at the same metric and time. If the existing one is wrong, propose rejecting it and say why; do not look for a nearby date to write around it.
- Get the date right. observed_at is when the figure was true, not when you found it. "Annualized revenue passed $100M in August" on a page published in September is an August observation.
- Get the unit right. Annualized run rate, trailing-twelve-month revenue, monthly revenue, gross merchandise value, and valuation are five different things. Record a figure only under the metric whose definition it matches. If a source gives monthly revenue, the run rate is twelve times it, and your note should say you did that arithmetic.
- One good source beats three that repeat each other. If two sources disagree, record neither until you understand why, and say so in the journal.
- Announced changes to a fetched schedule (an emission cut on the project's blog) or a dated event (an unlock) go on that metric with the EFFECTIVE date, not the announcement date; the row waits for the user like any other. The fetch owns the present, so do not record an announcement whose effective date has passed: the chain now says what happened. A withdrawn or delayed announcement is a reason to propose rejecting the row you recorded, not to record another.

A large move on a critical metric goes to the user as a proposal instead of into the signal. That is the system working: record it anyway, with a note that says where the figure comes from and how confident you are in it.

If you find nothing new, that is a result. Write down what you searched for, so the next run does not repeat it blindly.
