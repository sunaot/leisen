#!/usr/bin/env python3
from pathlib import Path
import argparse, shutil, textwrap

ROOT = Path(__file__).resolve().parents[1]

def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(content).lstrip(), encoding="utf-8")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project_dir")
    args = ap.parse_args()
    p = Path(args.project_dir)
    p.mkdir(parents=True, exist_ok=True)
    for d in ["00-brief","10-pain-research","15-market-research/captures","20-analysis","30-positioning","40-message","50-design","60-prototypes","70-qa","80-experiment"]:
        (p/d).mkdir(parents=True, exist_ok=True)
    write(p/"workflow-state.yaml", '''
    current_stage: brief
    stages:
      brief: {status: in_progress, version: 1}
      pain_research: {status: blocked, version: 0}
      market_research: {status: blocked, version: 0}
      analysis: {status: blocked, version: 0}
      positioning: {status: blocked, version: 0}
      message: {status: blocked, version: 0}
      design: {status: blocked, version: 0}
      prototype: {status: blocked, version: 0}
      qa: {status: blocked, version: 0}
    ''')
    write(p/"00-brief/brief.yaml", '''
    project_name: ""
    conversion_action: ""
    primary_target: ""
    target_context: ""
    traffic_source: "unknown"
    ad_promise: "unknown"
    market: "ja-JP"
    primary_device: "unknown"
    constraints: []
    open_questions: []
    ''')
    write(p/"00-brief/product-facts.yaml", '''
    product_name: ""
    category: ""
    facts: []
    limitations: []
    ''')
    write(p/"00-brief/claim-ledger.yaml", 'claims: []\n')
    write(p/"15-market-research/source-register.csv", 'source_id,source_class,name,url,captured_at,market,notes\n')
    write(p/"15-market-research/observations.jsonl", '')
    write(p/"10-pain-research/source-register.csv", 'source_id,source_type,actor,situation,url,notes\n')
    write(p/"10-pain-research/evidence.jsonl", '')
    write(p/"10-pain-research/pain-clusters.yaml", 'pain_clusters: []\n')
    write(p/"decisions.jsonl", '')
    print(f"Initialized {p}")

if __name__ == "__main__":
    main()
