#!/usr/bin/env python3
from pathlib import Path
import argparse, re

ORDER = ["brief","research","analysis","positioning","message","design","prototype","qa"]
VALID = {"blocked","in_progress","approved","stale"}

def parse_simple_yaml(text):
    result = {"current_stage": None, "stages": {}}
    m = re.search(r'^current_stage:\s*(\S+)', text, re.M)
    if m: result["current_stage"] = m.group(1)
    for stage in ORDER:
        m = re.search(rf'^\s{{2}}{stage}:\s*\{{status:\s*([^,}}]+),\s*version:\s*(\d+)(?:,\s*selected:\s*([^}}]+))?\}}', text, re.M)
        if m:
            result["stages"][stage] = {"status": m.group(1).strip(), "version": int(m.group(2)), "selected": (m.group(3).strip() if m.group(3) else None)}
    return result

def dump(data):
    lines = [f"current_stage: {data['current_stage']}", "stages:"]
    for s in ORDER:
        v = data["stages"].get(s, {"status":"blocked","version":0,"selected":None})
        selected = f", selected: {v['selected']}" if v.get("selected") else ""
        lines.append(f"  {s}: {{status: {v['status']}, version: {v['version']}{selected}}}")
    return "\n".join(lines)+"\n"

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("project_dir"); ap.add_argument("stage", choices=ORDER); ap.add_argument("status", choices=VALID)
    ap.add_argument("--selected")
    a=ap.parse_args(); path=Path(a.project_dir)/"workflow-state.yaml"
    data=parse_simple_yaml(path.read_text())
    v=data["stages"].setdefault(a.stage,{"status":"blocked","version":0,"selected":None})
    v["status"]=a.status; v["version"] += 1
    if a.selected: v["selected"]=a.selected
    data["current_stage"]=a.stage
    if a.status=="approved":
        i=ORDER.index(a.stage)
        if i+1<len(ORDER) and data["stages"][ORDER[i+1]]["status"]=="blocked":
            data["stages"][ORDER[i+1]]["status"]="in_progress"
            data["current_stage"]=ORDER[i+1]
    path.write_text(dump(data))
    print(f"Updated {a.stage} -> {a.status}")
if __name__=='__main__': main()
