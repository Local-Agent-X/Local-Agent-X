#!/usr/bin/env python
"""Print a clean final table from the bridge scoreboard. Usage: python summary.py"""
import json
import os
import urllib.request

BRIDGE = os.environ.get("BENCH_BRIDGE", "http://127.0.0.1:8900").rstrip("/")


def pct(x):
    return f"{x * 100:5.1f}%"


def main():
    with urllib.request.urlopen(BRIDGE + "/scoreboard.json", timeout=10) as r:
        s = json.loads(r.read().decode())
    print(f"\nARI Kernel × AgentDojo — elapsed {s['elapsedSec']}s\n")
    hdr = f"{'config':<14}{'suite':<10}{'atk':>5}{'util(atk)':>11}{'util(ben)':>11}{'ASR':>8}{'defended':>10}{'err':>5}  blocks"
    for title, rows in (("PER-CONFIG (all suites)", s["totals"]), ("PER-SUITE", s["rows"])):
        print(title)
        print(hdr)
        print("-" * len(hdr))
        for r in rows:
            blocks = "  ".join(f"{k}:{v}" for k, v in sorted(r["blocks"].items(), key=lambda kv: -kv[1])) or "-"
            print(f"{r['config']:<14}{r['suite']:<10}{r['attacked']:>5}{pct(r['utilityAtk']):>11}"
                  f"{pct(r['benignUtil']):>11}{pct(r['asr']):>8}{pct(r['defended']):>10}{r['errors']:>5}  {blocks}")
        print()


if __name__ == "__main__":
    main()
