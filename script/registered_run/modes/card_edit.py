"""Versioned inactive-persona edit proof; historical replay remains unchanged."""


def verify_card_edit(result, reg, summary):
    version = reg.get('cardEditContract')
    if version is None:
        # An old immutable registration must neither reinterpret its report
        # nor inspect a historical isolation directory which no longer exists.
        return None
    need(version == 'v1', 'REGISTERED_CARD_EDIT_CONTRACT_CHANGED')
    need(result.get('cardEditContract') == version, 'CARD_EDIT_RESULT_CONTRACT_CHANGED')
    code = ("const fs=require('node:fs'),path=require('node:path');"
            "const m=require(process.argv[1]),s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));"
            "process.stdout.write(JSON.stringify(m.verifySavedCardEdit(s,path.dirname(process.argv[2]))));")
    completed = subprocess.run([str(ROOT / reg['node']), '-e', code,
        str(ROOT / 'native-ui/card-edit-verdicts.cjs'), str(summary)], cwd=ROOT,
        capture_output=True, text=True, timeout=30, check=True)
    proof = json.loads(completed.stdout)
    # The versioned Node verifier checks the complete independent group and
    # saved files. A summary's self-reported success never substitutes for it.
    need(proof.get('passed') is True and proof.get('contract') == version and
         result.get('cardEditEvidence') == proof, 'CARD_EDIT_HOST_PROOF_CHANGED')
    return proof
