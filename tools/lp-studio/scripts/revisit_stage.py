#!/usr/bin/env python3
from pathlib import Path
from datetime import datetime, timezone
import argparse, json
from set_stage import ORDER, parse_simple_yaml, dump

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("project_dir"); ap.add_argument("stage", choices=ORDER); ap.add_argument("reason")
    a=ap.parse_args(); p=Path(a.project_dir); state=p/"workflow-state.yaml"
    data=parse_simple_yaml(state.read_text()); idx=ORDER.index(a.stage)
    data["stages"][a.stage]["status"]="in_progress"; data["stages"][a.stage]["version"] += 1
    for s in ORDER[idx+1:]:
        if data["stages"][s]["version"]>0 or data["stages"][s]["status"]!="blocked":
            data["stages"][s]["status"]="stale"
    data["current_stage"]=a.stage; state.write_text(dump(data))
    with (p/"decisions.jsonl").open("a",encoding="utf-8") as f:
        f.write(json.dumps({"type":"revisit","stage":a.stage,"reason":a.reason,"at":datetime.now(timezone.utc).isoformat()},ensure_ascii=False)+"\n")
    print(f"Reopened {a.stage}; downstream stages marked stale")
if __name__=='__main__': main()
