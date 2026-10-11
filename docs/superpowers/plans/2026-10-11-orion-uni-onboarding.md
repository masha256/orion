# UNI onboarding: plan

Spec: `docs/superpowers/specs/2026-10-11-orion-uni-onboarding-design.md`. One commit per task on `feat/uni`; suite + typecheck green after each.

1. `validateReading`: a `constant` source may write 0 on a `tokens` / `tokens_per_year` level or schedule. Test: constant 0 on staked_supply stored; erc20_supply 0 still refused.
2. `transfer_flow.from_any`: schema (exactly one of from_any / from_allowlist; count_from refused with from_any), plan (scan key + source id `*`), scanner (count every non-ignored sender, detail per address). Tests: plan, scanner counts an unknown sender and skips the ignored one, no unlisted anomaly; VVV golden + all hash pins unchanged.
3. `reporting.dilution` (rate metric, optional cap metric) in schema, loader, report and CLI line. Tests: dilution = min(rate, cap)/effective; absent block = unchanged reports.
4. `assets/uni.yaml` + `tests/assets/uni.ingest.test.ts` + persona paragraph; scratch-home live dry run, values into the spec's Amendments.
5. Placeholder whatif in the scratch home (reported as a placeholder, not a calibration). Stop for Mike's checkpoints.
