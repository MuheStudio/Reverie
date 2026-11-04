"""Versioned, independent persona-card export proof; old replay stays exact."""


def verify_card_export(result, reg, summary):
    version = reg.get('cardExportContract')
    # Missing means an immutable registration predating this feature. In
    # particular, never inspect a now-removed historical isolation directory.
    if version is None:
        return None
    need(version == 'v1', 'REGISTERED_CARD_EXPORT_CONTRACT_CHANGED')
    need(result.get('cardExportContract') == version, 'CARD_EXPORT_RESULT_CONTRACT_CHANGED')
    code = ("const fs=require('node:fs'),path=require('node:path');"
            "const m=require(process.argv[1]),s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));"
            "process.stdout.write(JSON.stringify(m.verifySavedCardExport(s,path.dirname(process.argv[2]))));")
    completed = subprocess.run([str(ROOT / reg['node']), '-e', code,
        str(ROOT / 'native-ui/card-export-verdicts.cjs'), str(summary)], cwd=ROOT,
        capture_output=True, text=True, timeout=30, check=True)
    proof = json.loads(completed.stdout)
    need(proof.get('passed') is True and proof.get('contract') == version and
         proof.get('checks') == 2 and proof.get('cycleChecks') == [2, 0] and
         result.get('cardExportEvidence') == proof, 'CARD_EXPORT_HOST_PROOF_CHANGED')
    return proof
