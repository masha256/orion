#!/usr/bin/env bash
# R2 prod release block steps 6(--yes)..10 under Mike's conditional pre-approval (2026-11-18). Stops at the first deviation.
set -u
. $TMPDIR/r2prod.sh
P=~/r2-prod; W=~/.hermes/profiles/raymond/workspace/orion/phase3-proof/r2
stop() { echo "STOP: $*"; exit 1; }
echo "== 6 reprice --yes $(date -u +%T)"
for a in $A; do PR data reprice $a --yes > $P/yes/reprice-$a.json || stop "$a reprice --yes exit $?"; done
python3 - <<'E' || stop "reprice yes != dry"
import json,sys
A="aero cake crv cvxcrv hype link lit pump sdcrv sky uni vvv ycrv".split(); bad=0
c=lambda r:[(m['metric'],m['repriced'],len(m['refused'])) for m in r['perMetric']]+[('remap',x['from'],x['rows']) for x in r['remapped']]+[(d['metric'],d['recomputed']) for d in r['derived']]
for a in A:
    d=json.load(open(f'/home/hermes/r2-prod/dry/reprice-{a}.json')); y=json.load(open(f'/home/hermes/r2-prod/yes/reprice-{a}.json'))
    ok=c(d)==c(y); bad+=not ok; print(a,'ok' if ok else f'MISMATCH {c(d)} != {c(y)}', y.get('exportFile'))
sys.exit(bad)
E
for a in $A; do PR data reprice $a | python3 -c 'import json,sys; r=json.load(sys.stdin); n=sum(m["repriced"] for m in r["perMetric"]); sys.exit(n!=0)' || stop "$a second dry run repriced rows"; done; echo "second dry: 0 repriced 13/13"
PR data compare-usd ycrv --days 400 | python3 -c 'import json,sys; r=json.load(sys.stdin); b=[m["metric"] for m in r if m["unpriced"]]; print("ycrv after reprice unpriced:", b or 0); sys.exit(bool(b))' || stop "ycrv still unpriced"
for a in $A; do [ $a = ycrv ] && continue; PR data compare-usd $a --days 400 | python3 -c 'import json,sys; r=json.load(sys.stdin); sys.exit(any(m["unpriced"] for m in r))' || stop "$a unpriced after reprice"; done; echo "compare-usd after reprice: 0 unpriced 13/13"

echo "== 7 R39 pre-check $(date -u +%T)"
python3 - <<'E' || stop "R39 pre-check"
import subprocess,json,sys
q="select asset_id, metric_key, count(*) filter (where status = $$rejected$$) as rejected, count(*) as total from observations where source_type = $$market_data$$ and metric_key in ($$price_usd$$, $$diem_price_usd$$) group by asset_id, metric_key order by asset_id, metric_key"
r=subprocess.run(['ssh','-i','/home/hermes/.ssh/orion-prod_ed25519','-o','IdentitiesOnly=yes','orion-prod@192.168.0.12','sql-ro',"'"+q+"'"],capture_output=True,text=True,timeout=120)
if r.returncode: print(r.stdout,r.stderr); sys.exit(1)
rows=json.loads(r.stdout)['rows']; print(' '.join(f"{x['asset_id']}:{x['metric_key']}={x['rejected']}/{x['total']}" for x in rows))
sys.exit(any(x['rejected'] for x in rows) or len(rows)!=14)
E
for a in $A; do PR data rebuild-price-levels $a > $P/dry/rebuild-$a.json; rc=$?; [ $rc -eq 0 ] || stop "$a rebuild dry exit $rc"; done
for a in $A; do python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); a=sys.argv[2]; pm=r["perMetric"]; bad=[m["metric"] for m in pm if m["refused"]]; bvf=sum(len(m["beforeValidFrom"]) for m in pm); want=25 if a=="aero" else 0; s="STOP: refused in "+",".join(bad) if bad else ("STOP: beforeValidFrom %d, expected %d" % (bvf, want) if bvf != want else "ok"); print(a, " ".join("%s rows=%d rebuild=%d refused=%d beforeValidFrom=%d" % (m["metric"], m["rows"], m["rebuilt"], len(m["refused"]), len(m["beforeValidFrom"])) for m in pm), s); sys.exit(s != "ok")' $P/dry/rebuild-$a.json $a || stop "$a rebuild dry check"; done
python3 -c 'import json; r=json.load(open("/home/hermes/r2-prod/dry/rebuild-aero.json")); m=r["perMetric"][0]; import sys; sys.exit(m["rebuilt"]!=20)' || stop "aero rebuilt != 20"
echo "-- 7 --yes"
for a in $A; do PR data rebuild-price-levels $a --yes > $P/yes/rebuild-$a.json || stop "$a rebuild --yes exit $?"; done
for a in $A; do python3 -c 'import json,sys; d,y=(json.load(open(f)) for f in sys.argv[1:3]); c=lambda r: [(m["metric"], m["rebuilt"]) for m in r["perMetric"]]; s="ok" if c(d)==c(y) else "MISMATCH dry %s != yes %s" % (c(d), c(y)); print(sys.argv[3], s); sys.exit(s != "ok")' $P/dry/rebuild-$a.json $P/yes/rebuild-$a.json $a || stop "$a rebuild yes != dry"; done

echo "== 8a $(date -u +%T)"
PR data purge-prices --source coingecko > $P/dry/purge-prices.json || stop "purge-prices dry exit $?"
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print("rows", sum(p["rows"] for p in r["prices"]), "refs", len(r["prices"]), "deletedTokens", r["deletedTokens"], "keptTokens", r["keptTokens"]); sys.exit(bool(r["keptTokens"]) or sorted(r["deletedTokens"])!=["coingecko:crvusd","coingecko:yearn-crv"])' $P/dry/purge-prices.json || stop "8a dry conditions"
PR data purge-prices --source coingecko --yes > $P/yes/purge-prices.json || stop "purge-prices --yes exit $?"
python3 -c 'import json,sys; d,y=(json.load(open(f)) for f in sys.argv[1:3]); c=lambda r: (sorted((p["tokenRef"], p["rows"]) for p in r["prices"]), sorted(r["deletedTokens"])); ok=c(d)==c(y); print("8a yes==dry" if ok else "MISMATCH", y.get("exportFile"), y.get("exportSha256")); sys.exit(not ok)' $P/dry/purge-prices.json $P/yes/purge-prices.json || stop "8a yes != dry"

echo "== 8b $(date -u +%T)"
for a in $A; do m=price_usd; [ $a = vvv ] && m=price_usd,diem_price_usd; PR data purge $a --metrics $m --source-type market_data > $P/dry/purge-$a.json || stop "$a purge dry exit $?"; done
for a in $A; do python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); a=sys.argv[2]; pm=r.get("perMetric", []); wr=sum(len(m.get("withoutReplacement", [])) for m in pm); want=25 if a=="aero" else 0; s="STOP: error "+json.dumps(r["error"]) if "error" in r else ("STOP: withoutReplacement %d, expected %d" % (wr, want) if wr != want else "ok"); print(a, " ".join("%s observations=%d withoutReplacement=%d" % (m["metric"], m["observations"], len(m.get("withoutReplacement", []))) for m in pm), s); sys.exit(s != "ok")' $P/dry/purge-$a.json $a || stop "$a 8b dry check"; done
for a in $A; do m=price_usd; [ $a = vvv ] && m=price_usd,diem_price_usd; PR data purge $a --metrics $m --source-type market_data --yes > $P/yes/purge-$a.json || stop "$a purge --yes exit $?"; done
for a in $A; do python3 -c 'import json,sys; d,y=(json.load(open(f)) for f in sys.argv[1:3]); c=lambda r: [(m["metric"], m["observations"]) for m in r["perMetric"]]; s="ok" if c(d)==c(y) else "MISMATCH dry %s != yes %s" % (c(d), c(y)); print(sys.argv[3], s, y.get("exportFile")); sys.exit(s != "ok")' $P/dry/purge-$a.json $P/yes/purge-$a.json $a || stop "$a 8b yes != dry"; done

echo "== 9 $(date -u +%T)"
for a in $A; do PR report yield $a --day $(day $a) > $P/after/$a.json || stop "$a after"; PR report yield $a --day $(d91 $a) > $P/after/$a-91.json || stop "$a-91 after"; done
echo "after $(ls $P/after | wc -l)"

echo "== 10 $(date -u +%T)"
T=/home/hermes/git/orion/.worktrees/rel-r2-prod; fails=0
for a in $A; do for f in $a $a-91; do python3 $T/tools/phase3-proof/flatdiff.py $P/before/$f.json $P/after/$f.json --allow $W/r2-allowlist-r43.json --asset $a > $P/gate-$f.txt 2>&1; rc=$?; echo "$f exit $rc $(tail -1 $P/gate-$f.txt)"; [ $rc -eq 0 ] || fails=$((fails+1)); done; done
echo "GATE fails=$fails"
[ $fails -eq 0 ] || exit 2
echo "ALL DONE $(date -u +%T)"
