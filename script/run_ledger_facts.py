#!/usr/bin/env python3
"""Print the factual part of a run's result section from its ledger.

Read-only: it opens <report>/run-ledger.json (and registration.json when
present) and prints a Markdown block of stages, counts, cleanup and pointer
facts. Analysis, causes and next steps stay hand-written. Usage:

    python3 -I script/run_ledger_facts.py .tools/reports/<registration-dir>
"""

from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
import sys


def seconds(row):
    if row.get('outerElapsedSeconds') is not None:
        return float(row['outerElapsedSeconds'])
    try:
        start = datetime.fromisoformat(row['startedUtc'])
        end = datetime.fromisoformat(row['endedUtc'])
    except (KeyError, TypeError, ValueError):
        return None
    return (end - start).total_seconds()


def counts(ledger):
    lines = []
    python = ledger.get('pythonEvidence') or {}
    if python:
        total = python.get('tests', python.get('testcases'))
        lines.append(f'- Python：{total} 条，逐例身份匹配：{python.get("identityMultiplicitiesMatch", python.get("identitiesMatch"))}')
    node = ledger.get('nodeEvidence') or {}
    if node:
        per_file = node.get('perFileTests')
        detail = '（' + '＋'.join(str(v) for v in per_file.values()) + '）' if per_file else ''
        lines.append(f'- Node：{node.get("tests")} 条{detail}')
    native = ledger.get('nativeEvidence') or {}
    if native.get('qtTestTotals') is not None:
        lines.append(f'- 原生：{native["qtTestTotals"]} 行＝{native.get("lifecycleRows")} 生命周期＋'
                     f'{native.get("functionalRows")} 功能，目标 {native.get("ctestTargets")} 个')
    elif native:
        lines.append(f'- 原生：PASS {native.get("passRows")}，SKIP {native.get("skipRows")}，totals {native.get("totals")}')
    result = ledger.get('ordinaryResult') or {}
    if result:
        exits = [f'{p.get("cycle")}:{p.get("exitCode")}' for p in result.get('processExits') or []]
        lines.append(f'- 普通检查：passed={result.get("passed")}，进程退出 {", ".join(exits)}，'
                     f'forcedCleanup={json.dumps(result.get("forcedCleanup"))}')
    if ledger.get('checkCountsByCycle'):
        lines.append(f'- 每轮检查数：{json.dumps(ledger["checkCountsByCycle"], ensure_ascii=False)}')
    if ledger.get('requests') is not None:
        lines.append(f'- HTTP 请求：{ledger["requests"]}')
    return lines


def main(argv):
    if len(argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    report = Path(argv[1])
    ledger = json.loads((report / 'run-ledger.json').read_text(encoding='utf-8'))
    out = [f'**结果：{"通过" if ledger.get("passed") else "失败"}**'
           + (f'，停点 `{ledger.get("stopReason") or ledger.get("error")}`' if not ledger.get('passed') else ''),
           f'源码 `{ledger.get("sourceHead", "")[:12]}`，开始 {ledger.get("startedUtc")}，结束 {ledger.get("endedUtc")}。', '',
           '| 阶段 | 退出码 | 耗时（秒） | 上限（秒） |', '|---|---|---|---|']
    for row in ledger.get('runs', []):
        duration = seconds(row)
        out.append(f'| {row.get("id")} | {row.get("exitCode")} | '
                   f'{"" if duration is None else round(duration, 1)} | {row.get("timeoutSeconds") or "—"} |')
    out.append('')
    out.extend(counts(ledger))
    checks = {key: ledger.get(key) for key in ('sourceUnchanged', 'historicalEvidenceUnchanged', 'unitScratchRemoved',
                                              'scratchRemoved', 'defaultPointerCandidateVerified',
                                              'priorDefaultPointerRestored') if key in ledger}
    if ledger.get('frozenChecks'):
        labels = [c.get('label') if isinstance(c, dict) else c for c in ledger['frozenChecks']]
        checks['frozenChecks'] = labels
    if 'ownedProcessesRemaining' in ledger:
        checks['ownedProcessesRemaining'] = ledger['ownedProcessesRemaining']
    out.append(f'- 保全与清理：{json.dumps(checks, ensure_ascii=False)}')
    if ledger.get('used'):
        out.append(f'- 额度使用：{json.dumps(ledger["used"], ensure_ascii=False)}')
    print('\n'.join(out))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
