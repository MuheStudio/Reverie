"""Host checks extracted from the passed formal r1 runner.

Function bodies retain their original comparisons and order. Invoke through an
explicit RunContext: its private namespace supplies paths and frozen contracts.
This module never imports or executes a historical report runner.
"""

def verify_persona_priority(result, reg, summary):
    need(reg.get('personaGui') == PERSONA_GUI_SPEC, 'PERSONA_GUI_CONTRACT_CHANGED')
    need(result.get('requests') == 28 and len(result.get('modelCalls', [])) == 28 and
         sum(call.get('kind') == 'book-settings-fixture' for call in result['modelCalls']) == 3, 'PERSONA_HTTP_COUNT_CHANGED')
    need(result.get('archiveDeadlineMs') == 120000 and result.get('personaRestartDeadlineMs') == 60000 and
         result.get('inputReadinessDeadlineMs') == 4000, 'PERSONA_OLD_DEADLINES_CHANGED')
    ordered = PERSONA_GUI_SPEC['orderedCheckNames']
    for cycle, report in enumerate(result['reports'], 1):
        expected = PERSONA_GUI_SPEC['expectedChecks']['cycle' + str(cycle)]
        legacy = ordered.get('cycle' + str(cycle), {})
        need(set(legacy) <= set(expected) and all(len(legacy[group]) == expected[group] for group in legacy),
             'PERSONA_ORDERED_NAME_CONTRACT_CHANGED')
        for group, count in expected.items():
            value = report.get(group, {})
            checks = value.get('checks', [])
            names = [row.get('name') if isinstance(row, dict) else None for row in checks]
            # Two legacy groups repeat check names by design; their full ordered
            # identity and multiplicity is registered. Every other group stays distinct.
            identity = names == legacy[group] if group in legacy else len(set(names)) == count
            need(value.get('passed') is True and len(checks) == count and
                 all(isinstance(row, dict) and row.get('passed') is True for row in checks) and
                 identity, 'PERSONA_GROUP_CHANGED:' + group)
    code = ("const fs=require('node:fs'),assert=require('node:assert/strict');"
            "const m=require(process.argv[1]),s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));"
            "const book=s.modelCalls.filter(c=>c.kind==='book-settings-fixture');"
            "const {legacyModelCalls,...p}=m.verifyWorldbookPriority(s.reports,s.modelCalls.filter(c=>c.kind!=='book-settings-fixture'),"
            "s.personaFixture.events,s.requests-book.length);"
            "assert.deepEqual(s.worldbookPriority,p);process.stdout.write(JSON.stringify(p));")
    completed = subprocess.run([str(ROOT / reg['node']), '-e', code,
        str(ROOT / 'native-ui/worldbook-priority-verdicts.cjs'), str(summary)], cwd=ROOT,
        capture_output=True, text=True, timeout=30, check=True)
    proof = json.loads(completed.stdout)
    need(proof.get('passed') is True and result.get('worldbookPriority') == proof, 'PRIORITY_PROOF_CHANGED')
    # The book-settings tail is recomputed from the raw summary by its own verifier.
    code = ("const fs=require('node:fs'),assert=require('node:assert/strict');"
            "const m=require(process.argv[1]),s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));"
            "const p=m.verifyWorldbookBookSettings(s.reports,s.modelCalls,s.personaFixture.events);"
            "assert.deepEqual(s.worldbookBookSettings,p);process.stdout.write(JSON.stringify(p));")
    completed = subprocess.run([str(ROOT / reg['node']), '-e', code,
        str(ROOT / 'native-ui/worldbook-book-settings-verdicts.cjs'), str(summary)], cwd=ROOT,
        capture_output=True, text=True, timeout=30, check=True)
    book = json.loads(completed.stdout)
    need(book == {'passed': True, 'checks': [7, 4], 'http': 3, 'preparationWrites': [1, 0], 'saveWrites': [2, 0], 'chats': [3, 0]} and result.get('worldbookBookSettings') == book,
         'BOOK_SETTINGS_PROOF_CHANGED')
    return {'priority': proof, 'bookSettings': book}

def verify_persona_row_inputs(result, reg, summary):
    need(reg.get('personaRowInputContract') == PERSONA_ROW_INPUT_SPEC, 'PERSONA_ROW_INPUT_CONTRACT_CHANGED')
    code = ("const fs=require('node:fs'),assert=require('node:assert/strict');"
            "const m=require(process.argv[1]),s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));"
            "assert.deepEqual(m.PERSONA_ROW_INPUT_CONTRACT,JSON.parse(process.argv[3]));"
            "const p=m.verifyPersonaRowInputs(s.reports,s.personaFixture.events);"
            "const a=m.verifyAuthorControlReadiness(s.reports);"
            "assert.deepEqual(s.personaRowInputEvidence,p);assert.deepEqual(s.authorControlInputEvidence,a);"
            "process.stdout.write(JSON.stringify({row:p,author:a}));")
    completed = subprocess.run([str(ROOT / reg['node']), '-e', code,
        str(ROOT / 'native-ui/worldbook-priority-verdicts.cjs'), str(summary), json.dumps(PERSONA_ROW_INPUT_SPEC)],
        cwd=ROOT, capture_output=True, text=True, timeout=30, check=True)
    proof = json.loads(completed.stdout)
    need(proof.get('row',{}).get('passed') is True and proof.get('author',{}).get('passed') is True and
         result.get('personaRowInputEvidence') == proof['row'] and result.get('authorControlInputEvidence') == proof['author'],
         'PERSONA_ROW_INPUT_PROOF_CHANGED')
    return proof
