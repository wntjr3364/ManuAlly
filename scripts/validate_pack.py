#!/usr/bin/env python3
"""Validate this planning pack. Does NOT run or validate the planned product."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from collections import Counter
from datetime import datetime, timezone

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', action='store_true', help='Write reports/PACK_VALIDATION.json')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    errors: list[str] = []
    warnings: list[str] = []
    checks: list[str] = []
    def load(p: str):
        try:
            return json.loads((root / p).read_text(encoding='utf-8'))
        except (OSError, ValueError) as exc:
            errors.append(f'{p}: {exc}')
            return None
    # Parse every JSON so examples and tables cannot silently become invalid.
    for file in sorted(root.rglob('*.json')):
        if 'node_modules' in file.parts:  # installed dependencies are not part of the pack (RFC-006)
            continue
        load(file.relative_to(root).as_posix())
    tm = load('tasks/TASK_MANIFEST.json')
    rm = load('docs/REQUIREMENTS.json')
    if not tm or not rm:
        print('\n'.join(errors)); return 1
    tasks = tm['tasks']; reqs = rm['requirements']
    tids = [t['id'] for t in tasks]; rids = [r['id'] for r in reqs]
    for kind, ids in [('task', tids), ('requirement', rids)]:
        for item, count in Counter(ids).items():
            if count != 1: errors.append(f'duplicate {kind}: {item}')
    tidset, ridset = set(tids), set(rids)
    reqmap = {r['id']: r for r in reqs}
    covered: set[str] = set()
    all_tests: list[str] = []
    phase_order = [f'P{i:02d}' for i in range(8)]
    for task in tasks:
        tid = task['id']
        if not (root / 'tasks' / f'{tid}.md').is_file(): errors.append(f'missing task packet: {tid}')
        for doc in task['read_first']:
            if not (root / doc).is_file(): errors.append(f'{tid} missing read_first: {doc}')
        for dep in task['depends_on']:
            if dep not in tidset: errors.append(f'{tid} unknown dependency: {dep}')
            elif tids.index(dep) >= tids.index(tid): errors.append(f'{tid} dependency not earlier: {dep}')
        if task['phase'] not in phase_order: errors.append(f'{tid} invalid phase')
        for scope in task['write_scope']:
            if scope.startswith('/') or '..' in Path(scope).parts: errors.append(f'{tid} unsafe scope: {scope}')
        expected: set[str] = set()
        for rid in task['requirements']:
            if rid not in ridset: errors.append(f'{tid} unknown requirement {rid}'); continue
            covered.add(rid)
            expected.update(a['test_id'] for a in reqmap[rid]['acceptance'])
        if expected != set(task['tests']): errors.append(f'{tid} test mapping mismatch')
        all_tests.extend(task['tests'])
    if covered != ridset: errors.append(f'uncovered requirements: {sorted(ridset-covered)}')
    duplicates = [t for t,n in Counter(all_tests).items() if n>1]
    if duplicates: errors.append(f'duplicate test IDs: {duplicates}')
    # DFS cycle check is independent of the intended serial ordering.
    graph = {t['id']: t['depends_on'] for t in tasks}
    visiting: set[str] = set(); done: set[str] = set()
    def visit(node: str):
        if node in visiting: errors.append(f'dependency cycle at {node}'); return
        if node in done or node not in graph: return
        visiting.add(node)
        for other in graph[node]: visit(other)
        visiting.remove(node); done.add(node)
    for tid in tids: visit(tid)
    checks.extend(['unique task/requirement/test identifiers','requirement→task→acceptance mapping','acyclic prior-task dependencies','read-first file existence','repository-relative write scopes','all JSON files parse'])
    source_data = load('docs/research/SOURCES.json') or []
    if any(not s['url'].startswith('https://') for s in source_data): errors.append('non-HTTPS source URL')
    sc = load('evals/SCIENTIFIC_CASES.json') or {'cases':[]}
    if len(sc['cases']) < 30: errors.append('fewer than 30 designed scientific cases')
    for case in sc['cases']:
        if case['expected'] not in {'ALLOW','BLOCK','WARN','NEEDS_EVIDENCE'}: errors.append(f'invalid science expectation: {case["id"]}')
    example_manifest = load('examples/EXAMPLE_MANIFEST.json') or {'examples':[]}
    schema_checked = 0
    try:
        import jsonschema
    except ImportError:
        warnings.append('jsonschema is not installed: example schema validation NOT RUN. Structural pack checks still run.')
    else:
        for item in example_manifest['examples']:
            schema = load(item['schema']); example = load(item['file'])
            if schema is None or example is None: continue
            try:
                jsonschema.Draft202012Validator.check_schema(schema)
                validator = jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker())
                valid = not list(validator.iter_errors(example))
                if valid != item['valid']: errors.append(f'example expected validity mismatch: {item["file"]}')
                schema_checked += 1
            except jsonschema.SchemaError as exc:
                errors.append(f'schema error {item["schema"]}: {exc.message}')
        checks.append('positive/negative starter JSON Schema examples')
    checks.append('30 scientific scenario designs structurally valid; model evaluation NOT RUN')
    report = {'status':'FAIL' if errors else ('PASS_WITH_NOT_RUN' if warnings else 'PASS'),
      'scope':'PLANNING_PACK_ONLY_NOT_PRODUCT_TESTS',
      'checked_at':datetime.now(timezone.utc).isoformat(),
      'tasks':len(tasks),'requirements':len(reqs),'acceptance_test_designs':len(all_tests),
      'scientific_case_designs':len(sc['cases']),'schema_examples_checked':schema_checked,
      'checks':checks,'errors':errors,'warnings':warnings,
      'not_validated':['web application implementation','live Claude/Codex accounts or policy admission','OS isolation effectiveness','scientific writing performance','document export rendering','backup/restore of a deployed application']}
    if args.report:
        (root/'reports').mkdir(exist_ok=True)
        (root/'reports/PACK_VALIDATION.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return 1 if errors else 0
if __name__=='__main__':
    raise SystemExit(main())
