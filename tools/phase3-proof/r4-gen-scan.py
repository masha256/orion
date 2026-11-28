#!/usr/bin/python3
"""Builds AERO's pool-scan YAML block (assets/aero.yaml, `scan: &aero_scan`) from the Phase 3 R4 scoping files, so no
address is typed by hand (plan Task 8; committed in Task 9). Prints the block to stdout; writes the per-address
provenance list (chain, role, address, scoping file) to --prov-out when given. Each address is asserted against the scoping
files (and the spec, for the LeafVoter, root Voter and subsidy creators) before it is printed. Stdlib only; reads files only (no network).

    python3 tools/phase3-proof/r4-gen-scan.py --scoping <phase3-r4-scoping dir> [--indent 10] [--prov-out <file>] \\
        [--spec <design.md>] [--pool-ts <src/ingest/adapters/pool.ts>]

The scoping dir holds `onchain-revenue.md`, `incentives-and-events.md`, `onchain-revenue-data/anchors-chainlink.json`,
`onchain-revenue-data/scripts/enum_head.json` and `incentives-data/{discovery,factory_tape_snapshots,
elysium_discovery}.json`. --spec and --pool-ts default to this checkout's R4 spec and adapter (the anchor description
allowlist ANCHOR_DESCRIPTIONS). --indent is the block's indent: 10 reproduces assets/aero.yaml's lines under
`scan: &aero_scan` byte for byte (tools/phase3-proof/test_r4.py checks it when the scoping dir is present).
"""
import argparse
import json
import os
import re

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
ap = argparse.ArgumentParser(description='AERO pool-scan YAML block from the R4 scoping files')
ap.add_argument('--scoping', required=True, help='the phase3-r4-scoping directory')
ap.add_argument('--spec', default=os.path.join(REPO, 'docs/superpowers/specs/2026-11-27-orion-phase3-r4-aero-pool-scan-design.md'))
ap.add_argument('--pool-ts', default=os.path.join(REPO, 'src/ingest/adapters/pool.ts'))
ap.add_argument('--indent', type=int, default=8, help='spaces before `chains:` (assets/aero.yaml: 10)')
ap.add_argument('--prov-out', help='write the provenance list (JSON) here')
args = ap.parse_args()

D = os.path.join(args.scoping, '')
eh = json.load(open(D + 'onchain-revenue-data/scripts/enum_head.json'))
disc = json.load(open(D + 'incentives-data/discovery.json'))
fts = json.load(open(D + 'incentives-data/factory_tape_snapshots.json'))
ely = json.load(open(D + 'incentives-data/elysium_discovery.json'))
an = json.load(open(D + 'onchain-revenue-data/anchors-chainlink.json'))
rev_md = open(D + 'onchain-revenue.md').read()
inc_md = open(D + 'incentives-and-events.md').read()
spec = open(args.spec).read()
src = open(args.pool_ts).read()
ALLOW = json.loads('[' + re.search(r"ANCHOR_DESCRIPTIONS: readonly string\[\] = \[(.*?)\];", src).group(1).replace("'", '"') + ']')

CHAINS = [('base', 8453), ('ethereum', 1), ('optimism', 10), ('arbitrum', 42161), ('ink', 57073), ('robinhood', 4663), ('arc', 5042), ('elysium', 99901)]
KIND = {'v2s': 'v2_stable', 'v2v': 'v2_volatile', 'cl': 'cl', 'lite_v2s': 'v2_stable', 'lite_v2v': 'v2_volatile', 'lite_cl': 'cl'}
LABEL = {'v2s': 'StablePoolFactory', 'v2v': 'VolatilePoolFactory', 'cl': 'CLFactory', 'lite_v2s': 'Aero Lite stable factory (0 pools)', 'lite_v2v': 'Aero Lite volatile factory (0 pools)', 'lite_cl': 'Aero Lite CLFactory'}
ORDER = ['v2s', 'v2v', 'cl', 'lite_v2s', 'lite_v2v', 'lite_cl']


def in_text(addr, *texts):
    return any(addr.lower() in t.lower() for t in texts)


def find(addr_re, text):
    m = re.search(addr_re, text)
    assert m, addr_re
    return m.group(0)

LEAF = find(r'0x382409fad8503FbCdbB27A4211551fa03e884078', spec)
ROOT = find(r'0x49d7d4f17Ec56Ef8fA04E464AF5D1A4942CC31e6', spec)
TGE = find(r'0x7269de76188E6597444D0859C4e5c336D3c39dDb', spec)
GOV = find(r'0x42255e3c2d0b71a0b006243148fdf1a71d054ce0', spec)
for a in (LEAF, ROOT, TGE, GOV):
    assert in_text(a, inc_md), a
assert in_text(LEAF, rev_md)

out = []


def w(line):
    out.append(' ' * (args.indent - 8) + line)


w('        chains:')
prov = []
for name, cid in CHAINS:
    facs = eh[name]['factories']
    keys = [k for k in ORDER if k in facs]
    assert set(keys) == set(facs), (name, facs.keys())
    # Every factory the chain's FactoryRegistry returns (discovery.json; Elysium: elysium_discovery.json), and the tape each
    # factory's own getter returns (factory_tape_snapshots.json "now" and "early").
    targets = set(disc['registry'][name]['targetFactories']) if name in disc['registry'] else set(ely['targetFactories'])
    assert {facs[k]['factory'].lower() for k in keys} == targets, name
    assert set(fts[f'{name}|now']['targetFactories']) == targets and set(fts[f'{name}|early']['targetFactories']) == targets, name
    registry = disc['registry'][name]['factoryRegistry'] if name in disc['registry'] else ely['factoryRegistry']
    reg_file = 'incentives-data/discovery.json' if name in disc['registry'] else 'incentives-data/elysium_discovery.json'
    assert in_text(registry, inc_md), (name, registry)
    w(f'          # {name} ({cid})')
    w(f'          - chain_id: {cid}')
    w('            factories:')
    for k in keys:
        f = facs[k]
        tape = f['tape']
        for snap in ('now', 'early'):
            assert fts[f'{name}|{snap}']['poolTapes'][f['factory'].lower()] == tape.lower()
        hook = f.get('defaultSwapHook') if KIND[k] == 'cl' else None
        if KIND[k] == 'cl':
            assert hook, (name, k)
        w(f'              # {LABEL[k]}: enum_head.json {name}.{k} (in {reg_file.split("/")[-1]} targets); tape: factory_tape_snapshots.json{"; hook: enum_head.json defaultSwapHook" if hook else ""}')
        line = f'              - {{ address: "{f["factory"]}", kind: {KIND[k]}, tape: "{tape}"' + (f', hook: "{hook}"' if hook else '') + ' }'
        w(line)
        prov.append((name, LABEL[k], f['factory'], f'enum_head.json + {reg_file}'))
        prov.append((name, f'{LABEL[k]} tape', tape, 'enum_head.json + factory_tape_snapshots.json'))
        if hook:
            prov.append((name, f'{LABEL[k]} hook', hook, 'enum_head.json defaultSwapHook'))
    w(f'            factory_registry: "{registry}" # {reg_file.split("/")[-1]}; incentives-and-events.md table')
    w(f'            leaf_voter: "{LEAF}" # LeafVoter: onchain-revenue.md section 10')
    prov.append((name, 'FactoryRegistry', registry, reg_file))
    prov.append((name, 'LeafVoter', LEAF, 'onchain-revenue.md §10'))
    w('            anchors:')
    if name == 'elysium':
        desc = an['feeds']['base']['desc']
        for token, (feed_chain, feed) in an['cross_chain_anchors']['elysium'].items():
            assert feed_chain == 'base'
            dsc = desc[feed][0]
            assert dsc in ALLOW, dsc
            assert in_text(token, rev_md) and in_text(feed, rev_md)
            w(f'              - {{ token: "{token}", feed: "{feed}", description: "{dsc}", feed_chain_id: 8453 }} # anchors-chainlink.json cross_chain_anchors')
            prov.append((name, f'anchor {dsc} (Base feed)', f'{token} -> {feed}', 'anchors-chainlink.json cross_chain_anchors'))
    else:
        for token, e in an['anchors'][name].items():
            if e['tier'] != 'A':
                continue
            assert e['feed_name'] in ALLOW, (name, e)
            assert an['feeds'][name]['desc'][e['feed']][0] == e['feed_name']
            assert in_text(token, rev_md) and in_text(e['feed'], rev_md), (name, token)
            w(f'              - {{ token: "{token}", feed: "{e["feed"]}", description: "{e["feed_name"]}" }} # {e["sym"]}: anchors-chainlink.json tier A')
            prov.append((name, f'anchor {e["sym"]} ({e["feed_name"]})', f'{token} -> {e["feed"]}', 'anchors-chainlink.json (tier A)'))
    w(f'            log_range: {"10000" if cid == 57073 else "1000000"}')
w('        # Programs these two create book as protocol_subsidy, every other creator as vote_incentives (spec section 11).')
w('        subsidy_creators:')
w(f'          - "{TGE}" # Aero Foundation TGE wallet: incentives-and-events.md table')
w(f'          - "{GOV}" # governance multisig: incentives-and-events.md table')
w(f'        root_voter: {{ chain_id: 8453, address: "{ROOT}" }} # Base root Voter: incentives-and-events.md table')
prov += [('all', 'subsidy creator TGE', TGE, 'spec §11 + incentives-and-events.md'), ('all', 'subsidy creator gov multisig', GOV, 'spec §11 + incentives-and-events.md'), ('base', 'root Voter', ROOT, 'spec §11 + incentives-and-events.md')]
print('\n'.join(out))
if args.prov_out:
    with open(args.prov_out, 'w') as f:
        json.dump(prov, f, indent=1)
