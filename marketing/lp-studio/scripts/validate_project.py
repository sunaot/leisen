#!/usr/bin/env python3
from pathlib import Path
import argparse, json, csv

def nonempty_after_colon(path, key):
    if not path.exists(): return False
    for line in path.read_text(encoding='utf-8').splitlines():
        if line.startswith(key+':'):
            v=line.split(':',1)[1].strip().strip('"\'')
            return bool(v) and v != 'unknown'
    return False

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('project_dir'); a=ap.parse_args(); p=Path(a.project_dir)
    errors=[]; warnings=[]
    brief=p/'00-brief/brief.yaml'
    for k in ['project_name','conversion_action','primary_target']:
        if not nonempty_after_colon(brief,k): errors.append(f'Missing brief field: {k}')
    obs=p/'10-research/observations.jsonl'
    if obs.exists():
        for i,line in enumerate(obs.read_text(encoding='utf-8').splitlines(),1):
            if not line.strip(): continue
            try:
                o=json.loads(line)
                for k in ['id','source_id','observation','evidence_class']:
                    if not o.get(k): errors.append(f'observations.jsonl line {i}: missing {k}')
                if o.get('performance_support') in ('moderate','strong') and not o.get('interpretation'):
                    warnings.append(f'line {i}: performance support declared; ensure source really contains outcome evidence')
            except Exception as e: errors.append(f'observations.jsonl line {i}: invalid JSON: {e}')
    claims=p/'00-brief/claim-ledger.yaml'
    if not claims.exists(): errors.append('Missing claim-ledger.yaml')
    print('ERRORS')
    for e in errors: print('-',e)
    print('WARNINGS')
    for w in warnings: print('-',w)
    if not errors: print('Project structure passes MVP validation.')
    raise SystemExit(1 if errors else 0)
if __name__=='__main__': main()
