"""Offline numeric TimingTrace analysis; never exports event text or credentials."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import importlib.util
import json
from pathlib import Path
import re

_spec = importlib.util.spec_from_file_location("reverie_qml_trace", Path(__file__).with_name("perf-trace.py"))
qml = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(qml)
MAX_RECORDS = 1048576
MAX_METACALL_CONTEXTS = 32768
RECEIVER_ROLES = {"unknown", "window", "sceneDirector", "chatPanel", "chatHistory", "chatComposer",
                  "runtimeBridge", "archiveEditor", "nativeAvatar"}
READING_COUNTER_NAMES = ("restoreRequestCount", "restoreExecutionCount", "forceLayoutCount")


def _safe_name(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", value) else "Unknown"


def _union(intervals):
    result = qml.Union()
    for start, end in sorted(intervals):
        result.add(start, end)
    return result.total


def timing_summary(document: dict, *, anomaly_intervals=None) -> dict:
    if "workloads" in document:
        if len(document["workloads"]) != 1:
            raise ValueError("Select one diagnostic workload/scene for timing analysis")
        scene = document["workloads"][0]["scene"]
    else:
        scene = document
    trace = scene if scene.get("schema") == "reverie.qt.timing-trace.v1" else scene.get("timingTrace")
    if not trace or trace.get("compiled") is not True:
        return {"timingTraceAvailable": False, "reason": "No compiled TimingTrace snapshot in this report"}
    if trace.get("schema") != "reverie.qt.timing-trace.v1":
        raise ValueError("Unsupported TimingTrace schema")
    origin = qml.integer(trace["startedNs"], minimum=1)
    records = trace["records"]
    if len(records) > MAX_RECORDS or len(records) != trace.get("recordCount"):
        raise ValueError("TimingTrace record count is invalid or exceeds the bounded reader")
    names = [_safe_name(v) for v in trace["kindNames"]]
    event_names = {str(k): _safe_name(v) for k, v in trace.get("eventTypeNames", {}).items()}
    begins, ends, points = {}, {}, []
    invalid = Counter()
    for raw in records:
        try:
            kind, edge = qml.integer(raw["kind"]), qml.integer(raw["edge"])
            if kind >= len(names) or edge not in (0, 1, 2):
                raise ValueError("Unknown kind or edge")
            row = {key: qml.integer(raw[key]) for key in ("elapsedNs", "spanId", "parentSpanId", "threadId")}
            row.update(kind=names[kind], edge=edge, phase=qml.integer(raw.get("phase", -1), minimum=-1),
                       input=qml.integer(raw.get("input", -1), minimum=-1),
                       a=qml.integer(raw.get("a", 0), minimum=-2**63), b=qml.integer(raw.get("b", 0), minimum=-2**63),
                       error=raw.get("error") is True, isGui=raw.get("isGui") is True)
        except (KeyError, ValueError, TypeError):
            invalid["invalidRecords"] += 1
            continue
        if not edge:
            points.append(row)
        elif not row["spanId"]:
            invalid["zeroSpanIds"] += 1
        else:
            target = begins if edge == 1 else ends
            if row["spanId"] in target:
                invalid["duplicateSpanEdges"] += 1
            else:
                target[row["spanId"]] = row
    spans = {}
    for identifier, begin in begins.items():
        end = ends.get(identifier)
        if end is None:
            continue  # A cutoff/stop does not supply a synthetic end.
        if any(begin[k] != end[k] for k in ("kind", "threadId", "parentSpanId")):
            invalid["mismatchedSpanEdges"] += 1
            continue
        if end["elapsedNs"] < begin["elapsedNs"]:
            invalid["negativeSpanDurations"] += 1
            continue
        spans[identifier] = {**begin, "endElapsedNs": end["elapsedNs"],
                             "durationNs": end["elapsedNs"] - begin["elapsedNs"],
                             "error": begin["error"] or end["error"], "exclusiveNs": None}
    invalid["orphanEnds"] = sum(i not in begins for i in ends)
    children = defaultdict(list)
    for identifier, begin in begins.items():
        children[begin["parentSpanId"]].append(identifier)
    for identifier, span in spans.items():
        contained = []
        complete_children = True
        for child_id in children[identifier]:
            child = spans.get(child_id)
            if child is None:
                complete_children = False
            elif child["threadId"] != span["threadId"] or not (
                    span["elapsedNs"] <= child["elapsedNs"] <= child["endElapsedNs"] <= span["endElapsedNs"]):
                invalid["invalidChildContainment"] += 1
                complete_children = False
            else:
                contained.append((child["elapsedNs"], child["endElapsedNs"]))
        if complete_children:
            span["exclusiveNs"] = span["durationNs"] - _union(contained)

    context_header = trace.get("metaCallContext")
    receiver_contexts = {}
    context_summary = None
    if context_header is not None:
        if not isinstance(context_header, dict) or context_header.get("schema") != "reverie.qt.metacall-context.v1" \
                or context_header.get("requested") is not True:
            raise ValueError("Unsupported MetaCall context schema or opt-in marker")
        capacity = qml.integer(context_header["capacity"])
        raw_contexts = context_header["records"]
        if capacity > MAX_METACALL_CONTEXTS or not isinstance(raw_contexts, list) \
                or len(raw_contexts) != context_header.get("recordCount") or len(raw_contexts) > capacity:
            raise ValueError("MetaCall context count exceeds the bounded reader")
        dropped = qml.integer(context_header["droppedContexts"])
        if context_header.get("complete") is not (dropped == 0):
            raise ValueError("Inconsistent MetaCall context completion marker")
        if context_header.get("parentNodeLimit") != 4 or context_header.get("classNameByteLimit") != 79:
            raise ValueError("Unsupported MetaCall metadata bounds")
        for raw in raw_contexts:
            try:
                identifier = qml.integer(raw["spanId"], minimum=1)
                begin = begins.get(identifier)
                metadata_ns = qml.integer(raw["elapsedNs"])
                if not begin or begin["kind"] != "NotifyEvent" or not begin["isGui"] \
                        or event_names.get(str(begin["a"])) != "MetaCall" \
                        or any(qml.integer(raw[key], minimum=-1) != begin[key] for key in ("threadId", "phase", "input")) \
                        or metadata_ns < begin["elapsedNs"] \
                        or identifier in spans and metadata_ns > spans[identifier]["endElapsedNs"]:
                    raise ValueError("MetaCall context has no matching GUI notification begin")
                if identifier in receiver_contexts:
                    raise ValueError("Duplicate MetaCall receiver context")
                chain = raw["chain"]
                if not isinstance(chain, list) or len(chain) > 5:
                    raise ValueError("Receiver parent chain exceeds its bound")
                nodes = []
                for node in chain:
                    if not isinstance(node, dict):
                        raise ValueError("Invalid receiver parent node")
                    name = node.get("className")
                    if name is not None and (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_:]{0,78}", name)):
                        raise ValueError("Unsafe or over-limit class name")
                    role = node.get("role")
                    if role not in RECEIVER_ROLES or node.get("roleKnown") is not (role != "unknown") \
                            or not isinstance(node.get("classNameTruncated"), bool):
                        raise ValueError("Invalid receiver role or metadata status")
                    nodes.append({"className": name, "classNameTruncated": node["classNameTruncated"],
                                  "role": role, "roleKnown": node["roleKnown"]})
                if not isinstance(raw.get("parentChainTruncated"), bool) or not isinstance(raw.get("metadataError"), bool):
                    raise ValueError("Unknown receiver metadata completion")
                receiver_contexts[identifier] = {"status": "observed", "elapsedNs": metadata_ns, "chain": nodes,
                    "parentChainTruncated": raw["parentChainTruncated"], "metadataError": raw["metadataError"],
                    "callbackIdentity": None, "nativeSourceStack": None}
            except (KeyError, ValueError, TypeError):
                invalid["invalidMetaCallContexts"] += 1
        metacall_begins = [b for b in begins.values() if b["kind"] == "NotifyEvent" and b["isGui"]
                          and event_names.get(str(b["a"])) == "MetaCall"]
        context_summary = {"requested": True, "capacity": capacity, "recordCount": len(raw_contexts),
            "complete": context_header["complete"],
            "validContextCount": len(receiver_contexts), "droppedContexts": dropped,
            "guiMetaCallBeginCount": len(metacall_begins),
            "missingContextCount": sum(b["spanId"] not in receiver_contexts for b in metacall_begins),
            "scope": "Receiver classes and fixed whitelist roles observed before forwarding. Missing or truncated metadata stays unknown. These values do not identify a callback, source stack or causal mechanism."}

    def label(row, *, include_context=True):
        value = {"kind": row["kind"]}
        if row["kind"] == "NotifyEvent":
            value.update(eventType=row["a"], eventTypeName=event_names.get(str(row["a"]), "UnknownEventType"),
                         observedWindow=row["b"] == 1)
            if include_context and context_summary is not None and value["eventTypeName"] == "MetaCall" and row["isGui"]:
                value["metaCallReceiver"] = receiver_contexts.get(row["spanId"],
                    {"status": "unknown", "reason": "No valid bounded receiver snapshot for this span", "chain": [],
                     "callbackIdentity": None, "nativeSourceStack": None})
        return value

    def chain(identifier):
        result, seen = [], set()
        current = identifier
        while current:
            if current in seen or len(result) >= 64:
                return {"known": False, "reason": "Cyclic or over-depth parent chain", "nodes": list(reversed(result))}
            seen.add(current)
            parent = begins.get(current)
            if parent is None:
                return {"known": False, "reason": "Parent begin is absent", "nodes": list(reversed(result))}
            if parent["threadId"] != begins[identifier]["threadId"]:
                return {"known": False, "reason": "Cross-thread parent cannot establish a call chain", "nodes": list(reversed(result))}
            result.append({"spanId": current, **label(parent)})
            current = parent["parentSpanId"]
        return {"known": True, "nodes": list(reversed(result))}

    def span_row(span):
        return {k: span[k] for k in ("spanId", "parentSpanId", "threadId", "isGui", "phase", "input", "elapsedNs", "endElapsedNs", "durationNs", "exclusiveNs", "error")} | label(span)

    groups = defaultdict(list)
    for span in spans.values():
        key = (span["threadId"], span["kind"], span["a"] if span["kind"] == "NotifyEvent" else None,
               span["b"] if span["kind"] == "NotifyEvent" else None)
        groups[key].append(span)
    group_rows = []
    for (thread, kind, a, b), values in groups.items():
        group_rows.append({"threadId": thread, **label(values[0], include_context=False), "closedSpans": len(values),
                           "inclusiveNs": sum(v["durationNs"] for v in values),
                           "unionNs": _union((v["elapsedNs"], v["endElapsedNs"]) for v in values),
                           "exclusiveNs": sum(v["exclusiveNs"] for v in values) if all(v["exclusiveNs"] is not None for v in values) else None,
                           "maxNs": max(v["durationNs"] for v in values)})
    longest = sorted(spans.values(), key=lambda x: -x["durationNs"])[:32]
    longest_rows = []
    for span in longest:
        direct = [spans[i] for i in children[span["spanId"]] if i in spans]
        longest_rows.append({**span_row(span), "parentChain": chain(span["spanId"]),
                             "directChildUnionNs": _union((v["elapsedNs"], v["endElapsedNs"]) for v in direct),
                             "directChildren": [span_row(v) for v in sorted(direct, key=lambda x: -x["durationNs"])[:12]],
                             "childPointKinds": dict(Counter(p["kind"] for p in points if p["parentSpanId"] == span["spanId"]))})
    windows = anomaly_intervals or []
    if len(windows) > qml.MAX_WINDOWS:
        raise ValueError("Too many timing anomaly intervals")
    overlaps = []
    for i, window in enumerate(windows):
        if window.get("clock") != "absolute-steady-clock":
            raise ValueError("TimingTrace anomaly intervals need the explicit steady-clock domain")
        start, end = qml.integer(window["startNs"]) - origin, qml.integer(window["endNs"]) - origin
        if end <= start:
            raise ValueError("Anomaly interval must have a positive duration")
        affected = []
        by_thread = defaultdict(list)
        for span in spans.values():
            a, b = max(start, span["elapsedNs"]), min(end, span["endElapsedNs"])
            if b > a:
                affected.append({**span_row(span), "overlapNs": b - a})
                by_thread[span["threadId"]].append((a, b))
        overlaps.append({"index": i, "startNs": start + origin, "endNs": end + origin,
                         "perThreadUnionNs": [{"threadId": t, "unionNs": _union(v)} for t, v in sorted(by_thread.items())],
                         "topSpans": sorted(affected, key=lambda x: -x["overlapNs"])[:20]})
    anchors = [{"absoluteObservedNs": origin + p["elapsedNs"], "phase": p["phase"],
                "legacyTotalElapsedNs": p["a"], "phaseElapsedNs": p["b"],
                "scope": "Successive elapsed-clock reads; not an independently bounded QML-profiler clock anchor"}
               for p in points if p["kind"] == "ClockAnchor"]
    counters = {k: trace.get(k) for k in ("droppedRecords", "stackOverflows", "spanOrderErrors", "errorSpans", "observedExceptionSpans", "incompleteSpans", "unpublishedRecords", "cutoffOmittedPoints", "cutoffOmittedSpanStarts", "cutoffOmittedSpanEnds", "stoppedOmittedSpanEnds", "essentialFailure")}
    restore_notifications = [{"absoluteObservedNs": origin + p["elapsedNs"],
        "elapsedNs": p["elapsedNs"], "parentSpanId": p["parentSpanId"], "threadId": p["threadId"],
        "phase": p["phase"], "input": p["input"], "counter": READING_COUNTER_NAMES[p["a"]],
        "value": p["b"] if p["b"] >= 0 else None}
        for p in points if p["kind"] == "ReadingRestoreCounter" and p["isGui"] and 0 <= p["a"] < 3]
    return {"timingTraceAvailable": True, "schema": "reverie.qt.timing-analysis.v1", "clock": "absolute-steady-clock",
            **({"metaCallContext": context_summary, "readingRestoreNotifications": restore_notifications}
               if context_summary is not None else {}),
            "startedNs": str(origin), "stoppedNs": trace.get("stoppedNs"), "cutoffNs": trace.get("cutoffNs"),
            "recordCount": len(records), "closedSpanCount": len(spans), "unclosedSpanCount": len(begins.keys() - ends.keys()),
            "unclosedSpans": [{"spanId": i, "threadId": begins[i]["threadId"], **label(begins[i]),
                               "startElapsedNs": begins[i]["elapsedNs"], "durationNs": None}
                              for i in sorted(begins.keys() - ends.keys())[:32]],
            "collectorCounters": counters, "analysisIssues": dict(invalid), "clockAnchors": anchors,
            "timeoutArrivals": sum(p["kind"] == "TimeoutArrival" for p in points),
            "timeoutRejected": sum(p["kind"] == "TimeoutRejected" for p in points),
            "spanGroups": sorted(group_rows, key=lambda x: -x["unionNs"]), "longestSpans": longest_rows,
            "anomalyOverlaps": overlaps,
            "selectedConstraintOutcome": document.get("selectedConstraintOutcome", scene.get("selectedConstraintOutcome")),
            "collectionComplete": document.get("collectionComplete", scene.get("collectionComplete")),
            "scope": "Closed wall-clock spans only; parent IDs are observed instrumented scope nesting, not unseen native stack frames. Exclusive subtracts child union within the same thread. Per-thread costs are never summed as CPU time. Missing ends, cutoff omissions and dropped records remain partial/unknown. Successful collection does not pass the original constraint."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene", type=Path, required=True)
    parser.add_argument("--anomalies", type=Path)
    parser.add_argument("--qml-trace", type=Path)
    parser.add_argument("--qml-clock-alignment", type=Path)
    parser.add_argument("--repo-root", type=Path)
    args = parser.parse_args()
    qml.regular_input(args.scene)
    windows = json.loads(args.anomalies.read_text()) if args.anomalies else None
    result = timing_summary(json.loads(args.scene.read_text()), anomaly_intervals=windows)
    if args.qml_trace:
        result["qmlTrace"] = qml.trace_summary(args.qml_trace, repo_root=args.repo_root,
                                             anomaly_intervals=windows,
                                             clock_alignment=json.loads(args.qml_clock_alignment.read_text()) if args.qml_clock_alignment else None)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
