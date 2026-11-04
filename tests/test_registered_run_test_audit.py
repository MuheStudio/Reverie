"""Static audit counterexamples; all source inputs are synthetic strings."""
import hashlib
from pathlib import Path

import pytest

from script.registered_run.test_audit import (
    TestAuditError, audit_test_changes, confirmation_for, parse_test_source,
    require_confirmed_audit,
)

ROOT = Path(__file__).resolve().parents[1]
OPTIONS = {"repository_root": ROOT, "node": str(ROOT / ".tools/node/bin/node")}
DIRECTION = {"path": "docs/confirmed-direction.md", "sha256": hashlib.sha256(b"confirmed plan").hexdigest(), "section": "W3 case changes"}


def manifest(framework, file, *names):
    cases = []
    for name in names:
        if framework == "qtest":
            cases.append({"framework": framework, "identity": "target::" + name, "file": None,
                          "target": "target", "name": name, "status": "passed"})
        else:
            cases.append({"framework": framework, "identity": file + "::" + name,
                          "file": file, "name": name, "status": "passed"})
    return {"cases": cases}


def audit(before, after, names=("test_signed",), **kwargs):
    path = "tests/test_sample.py"
    return audit_test_changes({path: before}, {path: after}, manifest("python", path, *names), **OPTIONS, **kwargs)


def cpp(rows='QTest::newRow("old") << 1;', body='QCOMPARE(1, 1);', method="caseName", extra=""):
    return 'class Case : public QObject { Q_OBJECT private slots: void ' + method + '_data() { QTest::addColumn<int>("input"); ' + rows + ' } void ' + method + '() { ' + body + ' } ' + extra + ' };'


def cpp_audit(before, after, names=("Case::caseName(old)",)):
    path = "native-ui/tests/CaseTest.cpp"
    return audit_test_changes({path: before}, {path: after}, manifest("qtest", None, *names), **OPTIONS)


def test_python_signed_deletion_is_rejected():
    result = audit("def test_signed():\n assert True\n", "def helper():\n return 1\n")
    assert result["signedChanges"][0]["kind"] == "deleted"
    assert result["registrationAllowed"] is False
    with pytest.raises(TestAuditError, match="UNCONFIRMED_SIGNED_TEST_CHANGES"):
        require_confirmed_audit(result)


def test_python_exact_body_rename_has_old_identity_and_new_name():
    result = audit("def test_signed():\n assert 1 == 1\n", "def test_new_name():\n assert 1 == 1\n")
    assert result["signedChanges"][0]["kind"] == "renamed"
    assert result["signedChanges"][0]["newName"] == "test_new_name"


def test_python_body_edit_requires_concrete_confirmation():
    before, after = "def test_signed():\n assert 1 == 1\n", "def test_signed():\n assert 1 == 2\n"
    result = audit(before, after)
    change = result["signedChanges"][0]
    assert change["kind"] == "body-edited"
    confirmation = confirmation_for(change, DIRECTION, authorization="用户确认此用例断言修正", confirmed_at="2026-10-27T10:00:00Z")
    result = audit(before, after, confirmations=[confirmation], direction_document=DIRECTION)
    assert result["registrationAllowed"] is True
    require_confirmed_audit(result)
    modified = after.replace("1 == 2", "1 == 3")
    assert audit(before, modified, confirmations=[confirmation], direction_document=DIRECTION)["registrationAllowed"] is False


def test_python_confirmation_requires_matching_direction_document_and_user_text():
    before, after = "def test_signed():\n assert True\n", "def test_signed():\n assert False\n"
    change = audit(before, after)["signedChanges"][0]
    confirmation = confirmation_for(change, DIRECTION, authorization="confirmed", confirmed_at="2026-10-27")
    changed_direction = {**DIRECTION, "sha256": "0" * 64}
    assert audit(before, after, confirmations=[confirmation], direction_document=changed_direction)["registrationAllowed"] is False
    assert audit(before, after, confirmations=[{**confirmation, "authorization": ""}], direction_document=DIRECTION)["registrationAllowed"] is False
    assert audit(before, after, confirmations=[{"identity": change["identity"]}], direction_document=DIRECTION)["registrationAllowed"] is False


def test_python_helpers_fixtures_and_additions_are_reported_separately():
    before = "def helper():\n return 1\ndef test_signed():\n assert helper()\n"
    after = "def helper():\n return 2\ndef test_signed():\n assert helper()\ndef test_added():\n assert True\n"
    result = audit(before, after)
    assert result["signedChanges"] == []
    assert result["registrationAllowed"] is True
    assert {row["kind"] for row in result["otherChanges"]} == {"helper-or-fixture-code-changed", "test-definition-added-or-unsigned-edited"}


def test_python_whitespace_and_comments_do_not_rewrite_signed_body():
    result = audit("def test_signed():\n assert True\n", "# comment\ndef test_signed():\n    assert True  # retained\n")
    assert result["signedChanges"] == []
    assert result["otherChanges"] == []
    assert len(result["changedFiles"]) == 1


def test_python_parametrized_class_body_edit_protects_each_signed_identity():
    path = "tests/test_sample.py"
    before = "class TestC:\n def test_signed(self, x):\n  assert x\n"
    after = before.replace("assert x", "assert not x")
    signed = manifest("python", path, "TestC::test_signed[a]", "TestC::test_signed[b]", "TestC::test_signed[b]")
    result = audit_test_changes({path: before}, {path: after}, signed, **OPTIONS)
    assert len(result["signedChanges"]) == 2
    assert result["signedRuntimeCases"] == 3


def test_python_decorator_or_parameter_input_edit_requires_confirmation():
    before = "@pytest.mark.parametrize('x', [1])\ndef test_signed(x):\n assert x\n"
    assert audit(before, before.replace("[1]", "[2]"), names=("test_signed[1]",))["registrationAllowed"] is False


def test_missing_signed_baseline_source_and_invalid_syntax_fail_closed():
    with pytest.raises(TestAuditError, match="SIGNED_BASELINE_SOURCE_UNRESOLVED"):
        audit("def helper(): pass", "def helper(): pass")
    with pytest.raises(TestAuditError, match="PYTHON_PARSE_FAILED"):
        audit("def test_signed(:", "def test_signed(): pass")


def test_cpp_new_literal_data_row_does_not_reapprove_signed_rows():
    before = cpp()
    after = cpp('QTest::newRow("old") << 1; QTest::newRow("new") << 2;')
    result = cpp_audit(before, after)
    assert result["signedChanges"] == []
    assert result["registrationAllowed"] is True
    additions = [row for row in result["otherChanges"] if row["kind"] == "data-row-added"]
    assert len(additions) == 1 and additions[0]["identity"] == "target::Case::caseName(new)"


def test_cpp_new_data_row_preserves_existing_duplicate_tags():
    before = cpp('QTest::newRow("old") << 1; QTest::newRow("old") << 2;')
    after = cpp('QTest::newRow("old") << 1; QTest::newRow("old") << 2; QTest::newRow("new") << 3;')
    result = cpp_audit(before, after, names=("Case::caseName(old)", "Case::caseName(old)"))
    assert result["signedChanges"] == []
    assert len([row for row in result["otherChanges"] if row["kind"] == "data-row-added"]) == 1


@pytest.mark.parametrize("rows", [
    'QTest::newRow("old") << 2;',
    'QTest::newRow("renamed") << 1;',
    'QTest::newRow("old") << 1; QTest::newRow("old") << 2;',
    'if (enabled) QTest::newRow("old") << 1;',
])
def test_cpp_existing_data_edits_or_duplicate_addition_require_confirmation(rows):
    result = cpp_audit(cpp(), cpp(rows))
    assert result["registrationAllowed"] is False
    assert any(row["kind"] == "data-body-edited" for row in result["signedChanges"])


def test_cpp_new_row_cannot_hide_changed_data_setup_or_existing_row_order():
    before = cpp('QTest::newRow("old") << 1; QTest::newRow("two") << 2;')
    after = cpp('QTest::newRow("two") << 2; QTest::newRow("old") << 1; QTest::newRow("new") << 3;')
    assert cpp_audit(before, after)["registrationAllowed"] is False
    after = cpp('QTest::newRow("old") << 1; QTest::newRow("new") << 2;').replace('addColumn<int>("input")', 'addColumn<int>("other")')
    assert cpp_audit(cpp(), after)["registrationAllowed"] is False


def test_cpp_unchanged_dynamic_rows_allow_an_independent_literal_addition():
    rows = 'for (const auto &value : values) { QTest::newRow(value) << value; }'
    before = cpp(rows)
    after = cpp(rows + ' QTest::newRow("new") << 2;')
    # After a loop block, conservatively do not claim it is an independent
    # statement: control-flow provenance cannot be inferred by the row lexer.
    assert cpp_audit(before, after)["registrationAllowed"] is False


def test_cpp_slot_body_rename_and_helper_only_edit():
    assert cpp_audit(cpp(), cpp(method="renamed"))["signedChanges"][0]["kind"] == "renamed"
    result = cpp_audit(cpp(extra="void cleanup() { reset(1); }"), cpp(extra="void cleanup() { reset(2); }"))
    assert result["signedChanges"] == []
    assert result["otherChanges"]
    assert cpp_audit(cpp(), cpp(body="QCOMPARE(1, 2);"))["registrationAllowed"] is False


def test_cpp_data_body_deletion_and_literal_braces_in_strings_fail_safely():
    before = cpp(body='const auto s = "} /* not a comment */"; QCOMPARE(s, "}");')
    assert cpp_audit(before, before)["registrationAllowed"] is True
    assert cpp_audit(cpp(), 'class Case : public QObject { private slots: void caseName() { QCOMPARE(1,1); } };')["registrationAllowed"] is False
    with pytest.raises(TestAuditError, match="CPP_UNCLOSED_DELIMITER"):
        cpp_audit(cpp(), cpp()[:-2])


def test_cpp_out_of_class_slot_bodies_are_protected():
    before = 'class Case : public QObject { private slots: void caseName(); }; void Case::caseName() { QVERIFY(true); }'
    after = before.replace("QVERIFY(true)", "QVERIFY(false)")
    result = cpp_audit(before, after, names=("Case::caseName()",))
    assert result["signedChanges"][0]["kind"] == "body-edited"


def test_node_primary_ast_parser_handles_regex_template_and_nested_braces():
    path = "tests/sample.test.cjs"
    source = "const test=require('node:test'); test('signed', () => { const regex = /[{}]/g; const s = `value ${(() => ({x:1}))().x}`; assert.ok(regex.test(s)); });"
    result = audit_test_changes({path: source}, {path: source}, manifest("node", path, "signed"), **OPTIONS)
    assert result["registrationAllowed"] is True
    changed = source.replace("assert.ok(regex.test(s))", "assert.equal(regex.test(s), false)")
    assert audit_test_changes({path: source}, {path: changed}, manifest("node", path, "signed"), **OPTIONS)["registrationAllowed"] is False


def test_node_rename_and_helper_change_are_distinct():
    path = "tests/sample.test.cjs"
    before = "const test=require('node:test');const helper=()=>1; test('signed', ()=>assert.equal(helper(),1));"
    helper_edit = before.replace("helper=()=>1", "helper=()=>2")
    result = audit_test_changes({path: before}, {path: helper_edit}, manifest("node", path, "signed"), **OPTIONS)
    assert result["signedChanges"] == []
    assert any(row["kind"] == "helper-or-fixture-code-changed" for row in result["otherChanges"])
    result = audit_test_changes({path: before}, {path: before.replace("'signed'", "'renamed'")}, manifest("node", path, "signed"), **OPTIONS)
    assert result["signedChanges"][0]["kind"] == "renamed"


def test_node_duplicate_names_compare_bodies_with_multiplicity():
    path = "tests/sample.test.cjs"
    call = "test('signed', ()=>assert.ok(true));"
    before = "const test=require('node:test');" + call + call
    result = audit_test_changes({path: before}, {path: before.replace(call, "", 1)}, manifest("node", path, "signed", "signed"), **OPTIONS)
    assert result["registrationAllowed"] is False
    assert len(result["signedChanges"]) == 1


def test_node_dynamic_prefix_names_resolve_without_evaluating_loop():
    path = "tests/sample.test.cjs"
    source = "const test=require('node:test'); for(const name of ['a','b']) test(`signed ${name}`, ()=>assert.ok(name));"
    result = audit_test_changes({path: source}, {path: source}, manifest("node", path, "signed a", "signed b"), **OPTIONS)
    assert result["registrationAllowed"] is True


def test_node_unbounded_name_or_ambiguous_dynamic_sites_reject():
    path = "tests/sample.test.cjs"
    with pytest.raises(TestAuditError, match="NODE_PARSE_FAILED"):
        parse_test_source(path, "test(name, ()=>{});", **OPTIONS)
    source = "test(`signed ${a}`, ()=>assert.ok(a)); test(`signed ${b}`, ()=>assert.equal(b,1));"
    with pytest.raises(TestAuditError, match="AMBIGUOUS_DYNAMIC_SIGNED_REGISTRATION"):
        audit_test_changes({path: source}, {path: source}, manifest("node", path, "signed a"), **OPTIONS)


def test_frontend_nested_suite_names_use_ast_ancestors():
    path = "frontend/sample.test.ts"
    source = "describe('suite', () => { describe('nested', () => { it('signed', () => { expect(1).toBe(1); }); }); });"
    result = audit_test_changes({path: source}, {path: source.replace("toBe(1)", "toBe(2)")}, manifest("frontend", path, "suite nested signed"), **OPTIONS)
    assert result["signedChanges"][0]["kind"] == "body-edited"


def test_missing_primary_node_parser_never_falls_back_to_regex(tmp_path):
    with pytest.raises(TestAuditError, match="TYPESCRIPT_PARSER_UNAVAILABLE"):
        parse_test_source("tests/a.cjs", "test('signed',()=>{});", repository_root=tmp_path)


def test_duplicate_python_source_definitions_are_ambiguous():
    source = "def test_signed():\n assert True\ndef test_signed():\n assert False\n"
    with pytest.raises(TestAuditError, match="AMBIGUOUS_SIGNED_SOURCE_DEFINITION"):
        audit(source, source)


def test_cpp_added_literal_cannot_collide_with_a_signed_dynamic_tag():
    rows = 'QTest::newRow("old") << 1; for (auto v : values) { QTest::newRow(v) << v; }'
    before = cpp(rows)
    after = cpp('QTest::newRow("new") << 2; ' + rows)
    result = cpp_audit(before, after, names=("Case::caseName(old)", "Case::caseName(new)"))
    assert result["registrationAllowed"] is False


def test_cpp_literal_addrow_is_additive_but_formatted_rows_require_confirmation():
    after = cpp('QTest::newRow("old") << 1; QTest::addRow("new") << 2;')
    assert cpp_audit(cpp(), after)["registrationAllowed"] is True
    formatted = cpp('QTest::newRow("old") << 1; QTest::addRow("new-%d", 1) << 2;')
    assert cpp_audit(cpp(), formatted)["registrationAllowed"] is False
