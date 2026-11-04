"""Read qmlprofiler XML offline without exporting QML source or event text."""
from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import re
import stat
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET

MAX_FILE_BYTES = 1024 * 1024 * 1024
MAX_NESTING = 4096
MAX_SAME_START = 4096
MAX_WINDOWS = 256


def integer(value, *, minimum=0):
    if isinstance(value, bool) or not re.fullmatch(r"[+-]?\d+", str(value)):
        raise ValueError("Expected an integral timing value")
    result = int(value)
    if result < minimum or result > 2**63 - 1:
        raise ValueError("Timing value is outside the supported range")
    return result


def regular_input(path: Path):
    info = path.lstat()
    if not path.is_absolute() or path.resolve() != path or not stat.S_ISREG(info.st_mode):
        raise ValueError("Trace must be an absolute canonical regular file")
    if not 0 < info.st_size <= MAX_FILE_BYTES:
        raise ValueError("Trace size is outside the diagnostic reader limit")


class Union:
    """Constant-memory union of intervals arriving in nondecreasing start order."""
    def __init__(self):
        self.total = 0
        self.start = self.end = None
        self.valid = True

    def add(self, start, end):
        if end <= start:
            return
        if self.start is not None and start < self.start:
            self.valid = False
            return
        if self.end is None or start > self.end:
            self.total += end - start
            self.start, self.end = start, end
        else:
            self.total += max(0, end - self.end)
            self.start = start
            self.end = max(self.end, end)


def source_location(filename, line, column, repo_root):
    """Only known repository paths; external/private paths are never echoed."""
    result = {"path": None, "line": None, "column": None, "known": False}
    for key, value in (("line", line), ("column", column)):
        try:
            result[key] = integer(value, minimum=1)
        except ValueError:
            pass
    if not filename or repo_root is None:
        return result
    root = Path(repo_root).resolve()
    parsed = urlsplit(filename)
    if parsed.scheme == "file" and parsed.netloc in ("", "localhost"):
        candidate = Path(unquote(parsed.path))
    elif parsed.scheme == "qrc" or filename.startswith(":/"):
        resource = unquote(parsed.path if parsed.scheme else filename[1:]).lstrip("/")
        if resource.startswith("native-ui/qml/"):
            candidate = root / resource
        elif resource.startswith("ui/") and "/" not in resource[len("ui/"):] and resource.endswith(".qml"):
            candidate = root / "native-ui/qml" / resource[len("ui/"):]
        elif resource.startswith("Reverie/") and "/" not in resource[len("Reverie/"):]:
            candidate = root / "native-ui/qml" / resource[len("Reverie/"):]
        else:
            return result
    elif not parsed.scheme:
        candidate = Path(filename) if Path(filename).is_absolute() else root / filename
    else:
        return result
    try:
        relative = candidate.resolve().relative_to(root)
        if candidate.is_file() and not candidate.is_symlink():
            result.update(path=relative.as_posix(), known=True)
    except (ValueError, OSError):
        pass
    return result


def normalize_windows(windows, alignment):
    if not windows:
        return [], {"available": False, "reason": "No anomaly intervals supplied"}
    if len(windows) > MAX_WINDOWS:
        raise ValueError("Too many anomaly intervals")
    offset = uncertainty = None
    if alignment is not None:
        offset = integer(alignment["absoluteSteadyNs"]) - integer(alignment["qmlTraceNs"])
        uncertainty = integer(alignment["uncertaintyNs"])
    normalized = []
    for i, window in enumerate(windows):
        start, end = integer(window["startNs"]), integer(window["endNs"])
        if end <= start:
            raise ValueError("Anomaly interval must have a positive duration")
        clock = window.get("clock")
        if clock == "absolute-steady-clock":
            if offset is None:
                return [], {"available": False, "reason": "No explicit common QML/steady-clock anchor; exact overlap cannot be established"}
            start, end = start - offset, end - offset
        elif clock != "qmlprofiler-nanoseconds":
            raise ValueError("Anomaly clock must be explicitly identified")
        normalized.append({"index": i, "startNs": start, "endNs": end})
    return normalized, {"available": True, "precise": uncertainty in (None, 0),
                        "uncertaintyNs": uncertainty or 0,
                        "scope": "Explicit clock mapping only; nonzero uncertainty makes overlaps nominal, not precise. Containment is not causal attribution."}


def trace_summary(path: Path, *, repo_root=None, anomaly_intervals=None, clock_alignment=None) -> dict:
    regular_input(path)
    if repo_root is None:
        repo_root = Path(__file__).resolve().parent.parent
    definitions, ranges = {}, Counter()
    metrics, edges = {}, Counter()
    stack, active, pending = [], [], []
    attributes = None
    all_union = Union()
    invalid_duration = invalid_start = no_duration = unsorted = crossing = equal = overflow = 0
    previous_start = pending_start = None
    windows, correlation = normalize_windows(anomaly_intervals, clock_alignment)
    window_stats = [{"window": w, "union": Union(), "events": {}, "ranges": 0} for w in windows]

    def metric(index):
        return metrics.setdefault(index, {"count": 0, "inclusiveNs": 0, "exclusiveNs": 0,
                                          "maxNs": 0, "union": Union()})

    def finish_node():
        node = active.pop()
        metric(node[2])["exclusiveNs"] += max(0, node[1] - node[0] - node[3].total)
        if active:
            active[-1][3].add(node[0], node[1])
            edges[(active[-1][2], node[2])] += 1

    def consume_pending():
        nonlocal crossing, equal, overflow
        for start, end, index in sorted(pending, key=lambda x: (x[0], -x[1], x[2])):
            while active and active[-1][1] <= start:
                finish_node()
            while active and end > active[-1][1]:
                crossing += 1
                finish_node()
            if active and (start, end) == tuple(active[-1][:2]):
                equal += 1
            if end > start:
                if len(active) >= MAX_NESTING:
                    overflow += 1
                else:
                    active.append([start, end, index, Union()])
        pending.clear()

    def tag(element):
        return element.tag.rsplit("}", 1)[-1]

    for action, element in ET.iterparse(path, events=("start", "end")):
        if action == "start":
            if not stack:
                if tag(element) != "trace":
                    raise ValueError("Output is not a qmlprofiler trace document")
                attributes = dict(element.attrib)
            stack.append(element)
            continue
        parent = stack[-2] if len(stack) > 1 else None
        if parent is not None and tag(element) == "event" and tag(parent) == "eventData":
            children = {tag(child): child.text for child in element}
            index = element.get("index")
            if index is None or index in definitions:
                raise ValueError("QML trace event definitions have invalid or duplicate indexes")
            # Never retain details, display text, QML expressions or message content.
            definitions[index] = {"type": children.get("type") or "unknown",
                                  "location": source_location(children.get("filename"), children.get("line"), children.get("column"), repo_root)}
            parent.remove(element)
        elif parent is not None and tag(element) == "range" and tag(parent) == "profilerDataModel":
            index = element.get("eventIndex", "missing")
            ranges[index] += 1
            if element.get("duration") is None:
                no_duration += 1
            else:
                try:
                    duration = integer(element.get("duration"))
                except ValueError:
                    invalid_duration += 1
                    duration = None
                try:
                    start = integer(element.get("startTime"))
                except ValueError:
                    invalid_start += 1
                    start = None
                if duration is not None and start is not None and start + duration <= 2**63 - 1:
                    end = start + duration
                    if previous_start is not None and start < previous_start:
                        unsorted += 1
                    previous_start = start
                    item = metric(index)
                    item["count"] += 1
                    item["inclusiveNs"] += duration
                    item["maxNs"] = max(item["maxNs"], duration)
                    item["union"].add(start, end)
                    all_union.add(start, end)
                    for group in window_stats:
                        w = group["window"]
                        a, b = max(start, w["startNs"]), min(end, w["endNs"])
                        if b > a:
                            group["ranges"] += 1
                            group["union"].add(a, b)
                            group["events"].setdefault(index, Union()).add(a, b)
                    if pending_start is not None and start != pending_start:
                        consume_pending()
                    pending_start = start
                    if len(pending) >= MAX_SAME_START:
                        overflow += 1
                    else:
                        pending.append((start, end, index))
                elif duration is not None and start is not None:
                    invalid_duration += 1
            parent.remove(element)
        stack.pop()
    if attributes is None:
        raise ValueError("QML trace document has no root")
    if any(index not in definitions for index in ranges):
        raise ValueError("QML trace ranges refer to absent event definitions")
    consume_pending()
    while active:
        finish_node()
    reliable_nesting = not (unsorted or crossing or equal or overflow or invalid_duration or invalid_start)
    counts = Counter()
    for index, count in ranges.items():
        counts[definitions[index]["type"]] += count

    def event_row(index):
        m = metric(index)
        return {"eventIndex": index, **definitions[index], "rangeCount": ranges[index],
                "timedRangeCount": m["count"], "inclusiveNs": m["inclusiveNs"],
                "unionNs": m["union"].total if m["union"].valid and not unsorted else None,
                "exclusiveNs": m["exclusiveNs"] if reliable_nesting else None, "maxNs": m["maxNs"]}

    rows = [event_row(i) for i in definitions if i in ranges]
    top = sorted(rows, key=lambda x: (-x["inclusiveNs"], x["eventIndex"]))[:40]
    correlations = []
    for group in window_stats:
        correlations.append({**group["window"], "overlappingRangeCount": group["ranges"],
                             "unionOverlapNs": group["union"].total if group["union"].valid and not unsorted else None,
                             "topSources": [{**event_row(i), "unionOverlapNs": u.total if u.valid and not unsorted else None}
                                            for i, u in sorted(group["events"].items(), key=lambda x: -x[1].total)[:20]]})
    return {"traceParsed": True, "traceHasEvents": bool(definitions and ranges), "traceFormat": "qmlprofiler-xml",
            "traceAttributes": attributes, "traceEventDefinitions": len(definitions), "traceRangeCount": sum(ranges.values()),
            "traceEventTypeCounts": dict(sorted(counts.items())),
            "traceTiming": {"units": "nanoseconds", "durationRangeCount": sum(m["count"] for m in metrics.values()),
                            "rangesWithoutDuration": no_duration, "invalidDurationRanges": invalid_duration,
                            "invalidStartRanges": invalid_start, "unsortedDurationStarts": unsorted,
                            "crossingDurationRanges": crossing, "equalBoundaryAmbiguities": equal,
                            "boundedNestingOverflow": overflow, "nestingReliable": reliable_nesting,
                            "durationUnionNs": all_union.total if all_union.valid and not unsorted else None,
                            "topSources": top, "containedRangeEdges": [
                                {"parent": event_row(a), "child": event_row(b), "count": n}
                                for (a, b), n in edges.most_common(40)] if reliable_nesting else [],
                            "scope": "Inclusive event durations must not be added across nested events. Union is wall-clock coverage, not CPU/GPU cost. Exclusive subtracts the union of direct temporal children only when ordering/containment is unambiguous; XML containment does not prove a native calling chain. Missing or malformed durations remain unknown.",
                            "clockCorrelation": {**correlation, "intervals": correlations}}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trace", type=Path, required=True)
    parser.add_argument("--repo-root", type=Path)
    parser.add_argument("--anomalies", type=Path, help="JSON array with explicit clock/startNs/endNs")
    parser.add_argument("--clock-alignment", type=Path, help="Explicit qmlTraceNs/absoluteSteadyNs/uncertaintyNs JSON")
    args = parser.parse_args()
    print(json.dumps(trace_summary(args.trace, repo_root=args.repo_root,
                                  anomaly_intervals=json.loads(args.anomalies.read_text()) if args.anomalies else None,
                                  clock_alignment=json.loads(args.clock_alignment.read_text()) if args.clock_alignment else None), ensure_ascii=False))


if __name__ == "__main__":
    main()
