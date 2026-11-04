"""Static, fail-closed comparison of signed tests and other test support code.

Python test definitions use ASTs. JavaScript/TypeScript uses the locally installed
TypeScript parser (parsing only; it never imports or evaluates project code).
C++ uses a delimiter-aware lexer for QTest slot definitions and literal data-row
statements. Unsupported or ambiguous signed registrations reject the audit.

A QTest ``_data`` addition is *only* an addition when deleting the new, literal,
top-level ``QTest::newRow("tag") << ...;`` (or unformatted ``addRow``) statements restores the complete old
``_data`` token stream and every old row statement is unchanged. Existing data
setup, control flow, dynamic rows, row expressions, order, and duplicate counts
are otherwise protected together with each signed row. Thus one new row never
silently authorizes changes to the old rows' inputs or assertions.
"""
from __future__ import annotations

import ast
import copy
import hashlib
import json
import re
import shutil
import subprocess
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Mapping, Sequence

from .identities import safe_relative_path, signed_baseline

SCHEMA = "reverie.registered-run.test-audit.v1"


class TestAuditError(ValueError):
    __test__ = False

    def __init__(self, code: str, **details: Any):
        self.code, self.details = code, details
        super().__init__(code + ": " + json.dumps(details, sort_keys=True, ensure_ascii=False))


def _need(condition: Any, code: str, **details: Any) -> None:
    if not condition:
        raise TestAuditError(code, **details)


def _hash(value: Any) -> str:
    text = value if isinstance(value, str) else json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _python(path: str, source: str) -> dict:
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as error:
        raise TestAuditError("PYTHON_PARSE_FAILED", file=path, line=error.lineno) from error
    records = []
    def visit(statements: list[ast.stmt], classes: tuple[str, ...] = ()) -> None:
        for node in statements:
            if isinstance(node, ast.ClassDef):
                visit(node.body, (*classes, node.name))
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_"):
                item = copy.deepcopy(node)
                item.name = "__test_name__"
                canonical = ast.dump(item, annotate_fields=True, include_attributes=False)
                records.append({"file": path, "framework": "python", "name": "::".join([*classes, node.name]),
                                "bodyHash": _hash(canonical), "line": node.lineno, "canonical": canonical})
    visit(tree.body)
    class StripTests(ast.NodeTransformer):
        def visit_FunctionDef(self, node: ast.FunctionDef) -> Any:
            return None if node.name.startswith("test_") else node
        visit_AsyncFunctionDef = visit_FunctionDef
    helpers = StripTests().visit(copy.deepcopy(tree))
    return {"records": records, "helperHash": _hash(ast.dump(helpers, include_attributes=False)), "parser": "python-ast"}


# Only TypeScript's syntax parser/printer are used. Names are patterns when the
# source registers a literal-prefix dynamic loop. Names are never evaluated.
_NODE_PARSER = r"""
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const ts = require(input.typescript);
const sf = ts.createSourceFile(input.file, input.source, ts.ScriptTarget.Latest, true,
  /\.tsx?$/.test(input.file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
if (sf.parseDiagnostics.length) throw new Error('syntax:' + sf.parseDiagnostics[0].start);
const printer = ts.createPrinter({removeComments:true, newLine:ts.NewLineKind.LineFeed});
const print = n => printer.printNode(ts.EmitHint.Unspecified,n,sf);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const names = n => {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return {literal:n.text, pattern:esc(n.text)};
  if (ts.isTemplateExpression(n)) {
    let pattern=esc(n.head.text);
    for(const span of n.templateSpans) pattern += '.*' + esc(span.literal.text);
    return {literal:null,pattern};
  }
  if(ts.isBinaryExpression(n) && n.operatorToken.kind===ts.SyntaxKind.PlusToken) {
    const a=names(n.left), b=names(n.right);
    return {literal:a.literal!==null && b.literal!==null ? a.literal+b.literal:null, pattern:a.pattern+b.pattern};
  }
  return {literal:null,pattern:'.*'};
};
let records=[], spans=[];
function visit(n, parents=[]) {
  if(ts.isCallExpression(n)) {
    let callee=n.expression, modifiers=[];
    while(ts.isPropertyAccessExpression(callee)) {modifiers.unshift(callee.name.text);callee=callee.expression;}
    const root=ts.isIdentifier(callee) ? callee.text : '';
    const isSuite=['describe','suite'].includes(root);
    const isTest=['test','it'].includes(root);
    if(isSuite || isTest) {
      if(!n.arguments.length) throw new Error('registration-without-name');
      const name=names(n.arguments[0]);
      const callback=n.arguments[n.arguments.length-1];
      if(!(ts.isArrowFunction(callback)||ts.isFunctionExpression(callback))) throw new Error('unsupported-callback');
      if(isSuite) {
        if(name.literal===null) throw new Error('dynamic-suite-name');
        // A suite body contributes registrations, never a single test body.
        ts.forEachChild(callback.body,c=>visit(c,parents.concat(name.literal)));
        return;
      }
      if(name.pattern==='.*') throw new Error('unbounded-dynamic-test-name');
      const prefix=parents.length ? parents.join(' ')+' ' : '';
      const options=n.arguments.slice(1,-1).map(print);
      const body=print(callback);
      records.push({name:name.literal===null?null:prefix+name.literal,
        namePattern:'^'+esc(prefix)+name.pattern+'$', body, options, modifiers,
        nameExpression:print(n.arguments[0]), line:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1});
      spans.push([n.getStart(sf),n.end]);
      return;
    }
  }
  ts.forEachChild(n,c=>visit(c,parents));
}
visit(sf);
let helpers=input.source;
for(const [start,end] of spans.sort((a,b)=>b[0]-a[0])) helpers=helpers.slice(0,start)+'__REGISTERED_TEST__'+helpers.slice(end);
const hf=ts.createSourceFile(input.file,helpers,ts.ScriptTarget.Latest,true,sf.scriptKind);
if(hf.parseDiagnostics.length) throw new Error('helper-parse');
process.stdout.write(JSON.stringify({records,helpers:printer.printFile(hf)}));
"""


def _node(path: str, source: str, *, repository_root: str | Path, node: str | None = None,
          typescript: str | Path | None = None) -> dict:
    root = Path(repository_root)
    parser_path = Path(typescript) if typescript else root / "frontend/node_modules/typescript/lib/typescript.js"
    executable = node or shutil.which("node")
    _need(bool(executable) and parser_path.is_file(), "TYPESCRIPT_PARSER_UNAVAILABLE", file=path)
    try:
        result = subprocess.run([str(executable), "-e", _NODE_PARSER],
                                input=json.dumps({"typescript": str(parser_path.absolute()), "file": path, "source": source}),
                                text=True, capture_output=True, timeout=30, cwd=root,
                                env={"PATH": "/usr/bin:/bin:/opt/homebrew/bin", "NODE_OPTIONS": ""}, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise TestAuditError("NODE_PARSER_FAILED", file=path, reason=type(error).__name__) from error
    _need(result.returncode == 0, "NODE_PARSE_FAILED", file=path, diagnostic=result.stderr[-1000:])
    try:
        value = json.loads(result.stdout)
    except ValueError as error:
        raise TestAuditError("NODE_PARSER_INVALID_OUTPUT", file=path) from error
    for record in value["records"]:
        record.update({"file": path, "framework": "frontend" if path.endswith((".ts", ".tsx")) else "node",
                       "bodyHash": _hash({"body": record.pop("body"), "options": record.pop("options"), "modifiers": record.pop("modifiers")})})
    return {"records": value["records"], "helperHash": _hash(value["helpers"]), "parser": "typescript-syntax-ast"}


# The lexer preserves string/raw-string tokens exactly and ignores comments and
# whitespace. It deliberately does not preprocess conditional C++ source.
_CPP_TOKEN = re.compile(r'''\s+|//[^\n]*(?:\n|$)|/\*[\s\S]*?\*/|(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|(?:u8|u|U|L)?"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_]\w*|\d+(?:\.\d+)?|::|<<|>>|->|&&|\|\||==|!=|<=|>=|\+\+|--|[^\s]''')


def _tokens(source: str) -> list[str]:
    tokens, offset = [], 0
    for match in _CPP_TOKEN.finditer(source):
        _need(match.start() == offset, "CPP_LEXER_GAP", offset=offset)
        token = match.group()
        offset = match.end()
        if not token.isspace() and not token.startswith(("//", "/*")):
            tokens.append(token)
    _need(offset == len(source), "CPP_LEXER_INCOMPLETE", offset=offset)
    return tokens


def _pairs(tokens: list[str]) -> dict[int, int]:
    stack, pairs = [], {}
    for index, token in enumerate(tokens):
        if token in ("{", "(", "["):
            stack.append((token, index))
        elif token in ("}", ")", "]"):
            _need(bool(stack), "CPP_UNBALANCED_DELIMITER", token=token)
            before, start = stack.pop()
            _need((before, token) in (("{", "}"), ("(", ")"), ("[", "]")), "CPP_MISMATCHED_DELIMITER")
            pairs[start] = index
    _need(not stack, "CPP_UNCLOSED_DELIMITER")
    return pairs


def _literal_cpp_string(token: str) -> str | None:
    if not token.startswith('"'):
        return None
    try:
        value = json.loads(token)
    except ValueError:
        return None
    return value if isinstance(value, str) else None


def _data_rows(tokens: list[str]) -> dict:
    """Extract independently removable direct literal row statements only."""
    rows, spans, depth = [], [], 0
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token == "{":
            depth += 1
        elif token == "}":
            depth -= 1
        if (tokens[index:index + 2] == ["QTest", "::"] and index + 3 < len(tokens)
                and tokens[index + 2] in ("newRow", "addRow") and tokens[index + 3] == "("):
            # Requiring a statement boundary prevents `if (x) newRow(...)`
            # from being mistaken for an independent additive data row.
            direct = depth == 1 and (index == 1 or tokens[index - 1] in (";", "{"))
            literal = _literal_cpp_string(tokens[index + 4]) if index + 5 < len(tokens) else None
            simple = direct and literal is not None and tokens[index + 5] == ")" and (
                tokens[index + 2] == "newRow" or "%" not in literal)
            end, nesting = index + 6, []
            while end < len(tokens):
                current = tokens[end]
                if current in ("{", "(", "["):
                    nesting.append(current)
                elif current in ("}", ")", "]"):
                    if not nesting:
                        break
                    nesting.pop()
                elif current == ";" and not nesting:
                    break
                end += 1
            if simple and end < len(tokens) and tokens[end] == ";":
                rows.append({"tag": literal, "bodyHash": _hash(tokens[index:end + 1]), "tokens": tokens[index:end + 1]})
                spans.append((index, end + 1))
        index += 1
    return {"rows": rows, "spans": spans}


def _cpp(path: str, source: str) -> dict:
    tokens = _tokens(source)
    pairs = _pairs(tokens)
    classes = []
    for index, token in enumerate(tokens):
        if token in ("class", "struct") and index + 1 < len(tokens) and re.fullmatch(r"\w+", tokens[index + 1]):
            opening = index + 2
            while opening < len(tokens) and tokens[opening] not in ("{", ";"):
                opening += 1
            if opening < len(tokens) and tokens[opening] == "{":
                classes.append((tokens[index + 1], opening, pairs[opening]))
    records, spans = [], []
    for cls, opening, closing in classes:
        index, slots = opening + 1, False
        while index < closing:
            if tokens[index] in ("public", "private", "protected", "signals", "Q_SIGNALS"):
                if tokens[index + 1:index + 3] in (["slots", ":"], ["Q_SLOTS", ":"]):
                    slots = True
                    index += 3
                    continue
                if tokens[index + 1:index + 2] == [":"]:
                    slots = False
                    index += 2
                    continue
            if tokens[index] == "void" and index + 3 < closing and tokens[index + 2] == "(":
                end_args = pairs[index + 2]
                after = end_args + 1
                while after < closing and tokens[after] in ("const", "override", "final", "noexcept"):
                    after += 1
                if after < closing and tokens[after] == "{" and slots:
                    end_body = pairs[after]
                    name = cls + "::" + tokens[index + 1]
                    body = tokens[index: end_body + 1]
                    # The method name is excluded only to identify exact-body
                    # rename candidates. Signature/qualifiers remain protected.
                    canonical = [*body[:1], "__test_name__", *body[2:]]
                    records.append({"framework": "qtest", "file": path, "name": name,
                                    "bodyHash": _hash(canonical), "canonical": canonical,
                                    "data": _data_rows(tokens[after:end_body + 1]) if name.endswith("_data") else None,
                                    "bodyTokens": tokens[after:end_body + 1]})
                    spans.append((index, end_body + 1))
                    index = end_body + 1
                    continue
                if after < closing and tokens[after] == ";" and slots:
                    # Definitions outside the class are handled below.
                    records.append({"framework": "qtest", "file": path, "name": cls + "::" + tokens[index + 1], "declaration": True})
            if tokens[index] == "{":
                index = pairs[index] + 1
            else:
                index += 1
    declarations = {row["name"] for row in records if row.get("declaration")}
    records = [row for row in records if not row.get("declaration")]
    for index in range(len(tokens) - 6):
        if tokens[index] == "void" and tokens[index + 2] == "::" and tokens[index + 4] == "(":
            name = tokens[index + 1] + "::" + tokens[index + 3]
            after = pairs[index + 4] + 1
            if tokens[after:after + 1] != ["{"]:
                continue
            end = pairs[after]
            canonical = [*tokens[index:index + 3], "__test_name__", *tokens[index + 4:end + 1]]
            records.append({"framework": "qtest", "file": path, "name": name,
                            "bodyHash": _hash(canonical), "canonical": canonical,
                            "data": _data_rows(tokens[after:end + 1]) if name.endswith("_data") else None,
                            "bodyTokens": tokens[after:end + 1]})
            spans.append((index, end + 1))
    residual = list(tokens)
    for start, end in sorted(spans, reverse=True):
        residual[start:end] = ["__QTEST_SLOT__"]
    return {"records": records, "declarations": sorted(declarations),
            "helperHash": _hash(residual), "parser": "cpp-delimiter-slot-parser"}


def parse_test_source(path: str, source: str, *, repository_root: str | Path = ".",
                      node: str | None = None, typescript: str | Path | None = None) -> dict:
    safe_relative_path(path)
    if path.endswith(".py"):
        return _python(path, source)
    if path.endswith((".cjs", ".mjs", ".js", ".ts", ".tsx")):
        return _node(path, source, repository_root=repository_root, node=node, typescript=typescript)
    if path.endswith((".cpp", ".cc", ".cxx", ".h", ".hpp")):
        return _cpp(path, source)
    return {"records": [], "helperHash": _hash(source), "parser": "opaque-support-file"}


def _signed_records(signed: Mapping[str, Any], parsed: Mapping[str, dict]) -> dict[str, list[dict]]:
    indexed: dict[str, list[dict]] = defaultdict(list)
    declared_slots = {name for file_result in parsed.values() for name in file_result.get("declarations", [])}
    for file_result in parsed.values():
        for record in file_result["records"]:
            indexed[record["framework"]].append(record)
    result = {}
    for case in signed["cases"]:
        framework, identity = case["framework"], case["identity"]
        if framework == "ctest":
            continue
        if framework == "python":
            file, function = identity.split("::", 1)
            function = function.split("[", 1)[0]
            matches = [r for r in indexed[framework] if r["file"] == file and r["name"] == function]
        elif framework in ("node", "frontend"):
            file, name = identity.split("::", 1)
            matches = [r for r in indexed[framework] if r["file"] == file and
                       (r.get("name") == name or (r.get("name") is None and re.fullmatch(r["namePattern"], name)))]
        else:
            # QTest row identity is target::Class::slot(tag). All data rows
            # share the slot body but keep separate signed runtime identities.
            name = case["name"].split("(", 1)[0]
            matches = [r for r in indexed[framework] if r["name"] == name]
            if not matches and name not in declared_slots and name.endswith(("::initTestCase", "::cleanupTestCase")):
                matches = [{"name": name, "file": None, "bodyHash": _hash("qtest-generated-lifecycle"), "generated": True}]
            # Two CTest executables can compile the same class. Shared source
            # definitions are still protected as one body per runtime identity.
        if matches:
            if framework in ("python", "qtest"):
                _need(len(matches) == 1, "AMBIGUOUS_SIGNED_SOURCE_DEFINITION",
                      framework=framework, identity=identity,
                      files=[record.get("file") for record in matches])
            result[framework + "|" + identity] = matches
    return result


def _data_additions(before: dict, after: dict) -> list[dict] | None:
    if not before.get("data") or not after.get("data"):
        return None
    old, new = before["data"]["rows"], after["data"]["rows"]
    old_counts = Counter((row["tag"], row["bodyHash"]) for row in old)
    new_counts = Counter((row["tag"], row["bodyHash"]) for row in new)
    if old_counts - new_counts:
        return None
    additions = new_counts - old_counts
    if not additions:
        return None
    # Preserve old literal duplicate tags, but new identities cannot collide
    # with any inherited tag or be repeated among additions.
    if any(count != 1 or tag in {r["tag"] for r in old} for (tag, _), count in additions.items()):
        return None
    remove_spans, remaining = [], additions.copy()
    for row, span in zip(new, after["data"]["spans"]):
        key = row["tag"], row["bodyHash"]
        if remaining[key]:
            remove_spans.append(span)
            remaining[key] -= 1
    trimmed = list(after["bodyTokens"])
    for start, end in reversed(remove_spans):
        del trimmed[start:end]
    if trimmed != before["bodyTokens"]:
        return None
    return [{"tag": tag, "bodyHash": body_hash} for (tag, body_hash), _ in sorted(additions.items())]


def _change(kind: str, framework: str, identity: str, before: Sequence[dict], after: Sequence[dict], **extra: Any) -> dict:
    before_hash = _hash(sorted(row["bodyHash"] for row in before)) if before else None
    after_hash = _hash(sorted(row["bodyHash"] for row in after)) if after else None
    payload = {"kind": kind, "framework": framework, "identity": identity,
               "beforeHash": before_hash, "afterHash": after_hash, **extra}
    return {**payload, "changeId": _hash(payload)}


def confirmation_for(change: Mapping[str, Any], direction_document: Mapping[str, str], *,
                     authorization: str, confirmed_at: str) -> dict:
    """Construct an exact confirmation record after explicit user confirmation.

    This helper formats a record; it supplies no authorization of its own.
    ``direction_document`` contains explicit ``path``, ``sha256``, ``section``.
    """
    return {"changeId": change["changeId"], "identity": change["identity"], "kind": change["kind"],
            "beforeHash": change["beforeHash"], "afterHash": change["afterHash"],
            "directionDocument": dict(direction_document), "authorization": authorization, "confirmedAt": confirmed_at}


def audit_test_changes(before_sources: Mapping[str, str], after_sources: Mapping[str, str],
                       signed_manifest: Mapping[str, Any], *, confirmations: Sequence[Mapping[str, Any]] = (),
                       direction_document: Mapping[str, str] | None = None,
                       repository_root: str | Path = ".", node: str | None = None,
                       typescript: str | Path | None = None) -> dict:
    """Audit explicit source snapshots and return a JSON-serializable report.

    Every signed runtime case must resolve against ``before_sources``. There is
    no executable source import, test collection, git checkout, or data read.
    Ambiguous registrations raise instead of producing a successful audit.
    """
    signed = signed_baseline(signed_manifest) if "expectedPythonIdentities" in signed_manifest else signed_manifest
    _need(isinstance(signed.get("cases"), list) and signed["cases"], "EMPTY_SIGNED_MANIFEST")
    options = {"repository_root": repository_root, "node": node, "typescript": typescript}
    before = {path: parse_test_source(path, source, **options) for path, source in before_sources.items()}
    after = {path: parse_test_source(path, source, **options) for path, source in after_sources.items()}
    old_index, new_index = _signed_records(signed, before), _signed_records(signed, after)
    expected = {case["framework"] + "|" + case["identity"] for case in signed["cases"] if case["framework"] != "ctest"}
    _need(expected <= set(old_index), "SIGNED_BASELINE_SOURCE_UNRESOLVED", identities=sorted(expected - set(old_index)))
    # Multiple possible dynamic registration sites with different bodies cannot
    # be assigned to a signed row without executing source; reject them.
    for index in (old_index, new_index):
        for key, records in index.items():
            if len(records) > 1 and any(record.get("name") is None for record in records):
                _need(len({record["bodyHash"] for record in records}) == 1, "AMBIGUOUS_DYNAMIC_SIGNED_REGISTRATION", identity=key)
    changes, others, used_old, used_new = [], [], set(), set()
    for key in sorted(expected):
        framework, identity = key.split("|", 1)
        old, new = old_index[key], new_index.get(key, [])
        used_old.update((r.get("file"), r["name"], r["bodyHash"]) for r in old)
        used_new.update((r.get("file"), r["name"], r["bodyHash"]) for r in new)
        if not new:
            candidates = [record for result in after.values() for record in result["records"]
                          if record["framework"] == framework and record["file"] in {r["file"] for r in old}
                          and record["bodyHash"] in {r["bodyHash"] for r in old}]
            if len(candidates) == 1:
                changes.append(_change("renamed", framework, identity, old, candidates, newName=candidates[0]["name"]))
                used_new.update((r["file"], r["name"], r["bodyHash"]) for r in candidates)
            else:
                changes.append(_change("deleted", framework, identity, old, []))
        elif Counter(r["bodyHash"] for r in old) != Counter(r["bodyHash"] for r in new):
            changes.append(_change("body-edited", framework, identity, old, new))
        if framework == "qtest":
            slot = old[0]["name"]
            old_data = [r for result in before.values() for r in result["records"] if r["name"] == slot + "_data"]
            new_data = [r for result in after.values() for r in result["records"] if r["name"] == slot + "_data"]
            if Counter(r["bodyHash"] for r in old_data) != Counter(r["bodyHash"] for r in new_data):
                additions = _data_additions(old_data[0], new_data[0]) if len(old_data) == len(new_data) == 1 else None
                if additions is not None and any(
                    framework + "|" + identity.split("::", 1)[0] + "::" + slot + "(" + row["tag"] + ")" in expected
                    for row in additions
                ):
                    additions = None
                if additions is None:
                    changes.append(_change("data-body-edited", framework, identity, old_data, new_data))
                else:
                    for row in additions:
                        record = {"kind": "data-row-added", "framework": framework, "file": new_data[0]["file"],
                                  "identity": identity.split("::", 1)[0] + "::" + slot + "(" + row["tag"] + ")", **row}
                        if record not in others:
                            others.append(record)
    # Report newly declared test bodies independently from helper/fixture code.
    # A file-level digest is retained even when only a test definition changed.
    old_records = {(r["framework"], r["file"], r["name"], r["bodyHash"]) for result in before.values() for r in result["records"]}
    new_records = {(r["framework"], r["file"], r["name"], r["bodyHash"]) for result in after.values() for r in result["records"]}
    for result in after.values():
        for record in result["records"]:
            key = record["framework"], record["file"], record["name"], record["bodyHash"]
            if key not in old_records and (record["file"], record["name"], record["bodyHash"]) not in used_new:
                others.append({"kind": "test-definition-added-or-unsigned-edited", "framework": record["framework"],
                               "file": record["file"], "name": record["name"], "bodyHash": record["bodyHash"]})
    for result in before.values():
        for record in result["records"]:
            key = record["framework"], record["file"], record["name"], record["bodyHash"]
            if key not in new_records and (record["file"], record["name"], record["bodyHash"]) not in used_old:
                others.append({"kind": "unsigned-test-definition-deleted-or-edited", "framework": record["framework"],
                               "file": record["file"], "name": record["name"], "bodyHash": record["bodyHash"]})
    files = []
    for path in sorted(set(before_sources) | set(after_sources)):
        before_hash = _hash(before_sources[path]) if path in before_sources else None
        after_hash = _hash(after_sources[path]) if path in after_sources else None
        if before_hash == after_hash:
            continue
        helper_changed = before.get(path, {}).get("helperHash") != after.get(path, {}).get("helperHash")
        files.append({"file": path, "beforeSha256": before_hash, "afterSha256": after_hash, "helpersChanged": helper_changed})
        if helper_changed:
            others.append({"kind": "helper-or-fixture-code-changed", "file": path,
                           "beforeHash": before.get(path, {}).get("helperHash"), "afterHash": after.get(path, {}).get("helperHash")})
    if direction_document is not None:
        _need(set(direction_document) == {"path", "sha256", "section"} and
              re.fullmatch(r"[0-9a-f]{64}", direction_document["sha256"]) and bool(direction_document["section"]), "INVALID_DIRECTION_DOCUMENT_BINDING")
        safe_relative_path(direction_document["path"])
    confirmed = []
    for change in changes:
        matches = []
        for confirmation in confirmations:
            if all(confirmation.get(field) == change[field] for field in ("changeId", "identity", "kind", "beforeHash", "afterHash")):
                if (direction_document is not None and confirmation.get("directionDocument") == dict(direction_document)
                        and isinstance(confirmation.get("authorization"), str) and confirmation["authorization"].strip()
                        and isinstance(confirmation.get("confirmedAt"), str) and confirmation["confirmedAt"].strip()):
                    matches.append(confirmation)
        _need(len(matches) <= 1, "DUPLICATE_CHANGE_CONFIRMATION", changeId=change["changeId"])
        change["confirmed"] = len(matches) == 1
        if matches:
            confirmed.append(change["changeId"])
    rejected = [change["changeId"] for change in changes if not change["confirmed"]]
    return {"schema": SCHEMA, "signedChanges": changes, "otherChanges": others, "changedFiles": files,
            "confirmationsAccepted": confirmed, "rejectedChangeIds": rejected, "registrationAllowed": not rejected,
            "directionDocument": dict(direction_document) if direction_document is not None else None,
            "signedRuntimeCases": len(signed["cases"]), "staticOnly": True, "testsExecuted": False,
            "semantics": {"duplicateRuntimeIdentities": "retained; shared bodies are audited for every signed identity",
                          "qtestDataAddition": "new independent literal row statements only; removing them must reproduce old complete data body",
                          "helpersAndFixtures": "reported separately; no transitive product-code or helper behavior equivalence is claimed"}}


def require_confirmed_audit(report: Mapping[str, Any]) -> None:
    _need(report.get("schema") == SCHEMA and report.get("registrationAllowed") is True and
          report.get("rejectedChangeIds") == [] and isinstance(report.get("signedChanges"), list) and
          all(change.get("confirmed") is True for change in report["signedChanges"]), "UNCONFIRMED_SIGNED_TEST_CHANGES",
          rejected=report.get("rejectedChangeIds"))


def read_git_sources(repository_root: str | Path, revision: str, paths: Sequence[str]) -> dict[str, str]:
    """Read only explicit tracked test/support paths from a commit, never data/."""
    _need(isinstance(revision, str) and re.fullmatch(r"[A-Za-z0-9_./-]+", revision) and not revision.startswith("-"), "INVALID_GIT_REVISION")
    result = {}
    for path in paths:
        safe_relative_path(path)
        completed = subprocess.run(["git", "show", revision + ":" + path], cwd=repository_root,
                                   capture_output=True, text=True, check=False)
        _need(completed.returncode == 0, "GIT_SOURCE_READ_FAILED", file=path)
        result[path] = completed.stdout
    return result
