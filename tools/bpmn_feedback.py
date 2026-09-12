#!/usr/bin/env python3
"""Read persisted BPMN fixtures, generate reports, and run quality checks."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import os
import re
import shlex
import shutil
import subprocess
import tempfile
from collections import Counter
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {
    "bpmn": "http://www.omg.org/spec/BPMN/20100524/MODEL",
    "bpmndi": "http://www.omg.org/spec/BPMN/20100524/DI",
    "dc": "http://www.omg.org/spec/DD/20100524/DC",
    "di": "http://www.omg.org/spec/DD/20100524/DI",
    "vendor": "https://example.com/vendor/bpmn",
    "xsi": "http://www.w3.org/2001/XMLSchema-instance",
}

for prefix, uri in NS.items():
    ET.register_namespace(prefix, uri)

CONTAINER_TYPES = {"lane", "participant", "subProcess"}
FLOW_NODE_TYPES = {
    "task",
    "userTask",
    "serviceTask",
    "sendTask",
    "receiveTask",
    "manualTask",
    "scriptTask",
    "businessRuleTask",
    "callActivity",
    "subProcess",
    "startEvent",
    "endEvent",
    "intermediateCatchEvent",
    "intermediateThrowEvent",
    "boundaryEvent",
    "exclusiveGateway",
    "inclusiveGateway",
    "parallelGateway",
    "eventBasedGateway",
    "complexGateway",
}
ROUTE_UNIT = 50


def q(prefix: str, local: str) -> str:
    return f"{{{NS[prefix]}}}{local}"


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def persisted_fixtures() -> dict[str, str]:
    fixture_dir = Path("fixtures")
    fixtures = sorted(fixture_dir.glob("*.bpmn"))
    if not fixtures:
        raise SystemExit(f"no persisted BPMN fixtures found under {fixture_dir}")
    return {fixture.name: fixture.read_text(encoding="utf8") for fixture in fixtures}


def parse_xml(path: Path) -> ET.Element:
    return ET.parse(path).getroot()


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def referential_integrity_problems(root: ET.Element) -> list[str]:
    """Structural, engine-agnostic sanity check on the BPMN *semantics*
    (never the DI): no duplicate ids, no dangling sourceRef/targetRef/
    attachedToRef/processRef/flowNodeRef, and every <incoming>/<outgoing>
    declaration agrees with the flow it names. Cheap (pure XML parsing, no
    layout engine) so it can run on every fixture, including the generated
    corpus (#57's own success criterion: "no dangling refs, no duplicate
    ids, no <incoming>/<outgoing> mismatches")."""
    problems: list[str] = []
    ids: dict[str, ET.Element] = {}
    for element in root.iter():
        if not element.tag.startswith("{" + NS["bpmn"] + "}"):
            continue
        element_id = element.get("id")
        if not element_id:
            continue
        if element_id in ids:
            problems.append(f"duplicate id: {element_id}")
        else:
            ids[element_id] = element

    def resolves(ref: str | None) -> bool:
        return bool(ref) and ref in ids

    for flow in list(root.iter(q("bpmn", "sequenceFlow"))) + list(root.iter(q("bpmn", "messageFlow"))) + list(
        root.iter(q("bpmn", "association"))
    ):
        flow_id = flow.get("id", "<unnamed>")
        source_id = flow.get("sourceRef")
        target_id = flow.get("targetRef")
        if not resolves(source_id):
            problems.append(f"{flow_id}: sourceRef does not resolve ({source_id})")
        if not resolves(target_id):
            problems.append(f"{flow_id}: targetRef does not resolve ({target_id})")

    for element in root.iter():
        if not element.tag.startswith("{" + NS["bpmn"] + "}"):
            continue
        element_id = element.get("id", "<unnamed>")
        for incoming in element.findall(q("bpmn", "incoming")):
            flow_id = (incoming.text or "").strip()
            flow = ids.get(flow_id)
            # `flow is None`, never `not flow`: an ET.Element with no
            # subelements (every sequenceFlow here) is falsy under Python's
            # bool() even when the lookup found it (ElementTree's __bool__
            # is `len(children) > 0`, not "is this a real element") -- `not
            # flow` would misreport every resolved flow as dangling.
            if flow is None:
                problems.append(f"{element_id}: <incoming> names unresolved flow {flow_id!r}")
            elif flow.get("targetRef") != element.get("id"):
                problems.append(f"{element_id}: <incoming> {flow_id} does not target this element")
        for outgoing in element.findall(q("bpmn", "outgoing")):
            flow_id = (outgoing.text or "").strip()
            flow = ids.get(flow_id)
            if flow is None:
                problems.append(f"{element_id}: <outgoing> names unresolved flow {flow_id!r}")
            elif flow.get("sourceRef") != element.get("id"):
                problems.append(f"{element_id}: <outgoing> {flow_id} does not source from this element")
        attached_to = element.get("attachedToRef")
        if attached_to is not None and not resolves(attached_to):
            problems.append(f"{element_id}: attachedToRef does not resolve ({attached_to})")
        process_ref = element.get("processRef")
        if process_ref is not None and not resolves(process_ref):
            problems.append(f"{element_id}: processRef does not resolve ({process_ref})")
        for flow_node_ref in element.findall(q("bpmn", "flowNodeRef")):
            ref = (flow_node_ref.text or "").strip()
            if not resolves(ref):
                problems.append(f"{element_id}: flowNodeRef does not resolve ({ref!r})")
    return problems


def bounds_from(element: ET.Element) -> dict[str, float] | None:
    bounds = element.find(q("dc", "Bounds"))
    if bounds is None:
        return None
    return {key: float(bounds.get(key, "0")) for key in ("x", "y", "width", "height")}


def label_bounds_from(element: ET.Element) -> dict[str, float] | None:
    label = element.find(q("bpmndi", "BPMNLabel"))
    if label is None:
        return None
    return bounds_from(label)


def box_overlap(a: dict[str, float], b: dict[str, float]) -> float:
    width = min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"])
    height = min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"])
    return width * height if width > 0 and height > 0 else 0.0


def contains(outer: dict[str, float], inner: dict[str, float]) -> bool:
    return (
        inner["x"] >= outer["x"]
        and inner["y"] >= outer["y"]
        and inner["x"] + inner["width"] <= outer["x"] + outer["width"]
        and inner["y"] + inner["height"] <= outer["y"] + outer["height"]
    )


def segment_intersects_box(a: tuple[float, float], b: tuple[float, float], box: dict[str, float]) -> bool:
    x0, y0 = box["x"], box["y"]
    x1, y1 = box["x"] + box["width"], box["y"] + box["height"]
    if abs(a[1] - b[1]) < 0.5:
        y = a[1]
        if y <= y0 or y >= y1:
            return False
        return max(min(a[0], b[0]), x0) < min(max(a[0], b[0]), x1)
    if abs(a[0] - b[0]) < 0.5:
        x = a[0]
        if x <= x0 or x >= x1:
            return False
        return max(min(a[1], b[1]), y0) < min(max(a[1], b[1]), y1)
    return False


def is_monotonic_lane_crossing(
    points: list[tuple[float, float]],
    candidate_bounds: dict[str, float],
    source_container_bounds: dict[str, float],
    target_container_bounds: dict[str, float],
    tolerance: float = 0.5,
) -> bool:
    """Whether a route between two different lanes/pools may cross
    `candidate_bounds` -- a container neither endpoint belongs to -- because
    it sits strictly between the endpoints' own containers and the route's
    full extent never strays outside the corridor spanning them. Lanes are
    stacked bands (this engine only stacks them along y); a route connecting
    lane 1 to lane 3 has no geometry that avoids lane 2 in between, and that
    is monotonic traversal to its own two endpoints, not an excursion into
    someone else's territory (#64; #11 is the real excursion case this
    exemption must not also swallow -- checked below by bounding the route
    to the corridor, not just checking the candidate's position)."""
    lo = min(source_container_bounds["y"], target_container_bounds["y"])
    hi = max(
        source_container_bounds["y"] + source_container_bounds["height"],
        target_container_bounds["y"] + target_container_bounds["height"],
    )
    candidate_lo = candidate_bounds["y"]
    candidate_hi = candidate_lo + candidate_bounds["height"]
    if candidate_lo < lo - tolerance or candidate_hi > hi + tolerance:
        return False  # not actually between the endpoints' own containers
    route_lo = min(p[1] for p in points)
    route_hi = max(p[1] for p in points)
    return route_lo >= lo - tolerance and route_hi <= hi + tolerance


def point_within(point: tuple[float, float], box: dict[str, float], tolerance: float = 0.5) -> bool:
    x, y = point
    return (
        x >= box["x"] - tolerance
        and y >= box["y"] - tolerance
        and x <= box["x"] + box["width"] + tolerance
        and y <= box["y"] + box["height"] + tolerance
    )


def point_on_boundary(point: tuple[float, float], box: dict[str, float]) -> bool:
    x, y = point
    x0, y0 = box["x"], box["y"]
    x1, y1 = x0 + box["width"], y0 + box["height"]
    return (
        (x0 <= x <= x1 and (abs(y - y0) < 0.5 or abs(y - y1) < 0.5))
        or (y0 <= y <= y1 and (abs(x - x0) < 0.5 or abs(x - x1) < 0.5))
    )


def valid_bounds(bounds: dict[str, float] | None) -> bool:
    return bool(bounds and bounds["width"] > 0 and bounds["height"] > 0)


_SIDE_OUTWARD_NORMAL: dict[str, tuple[int, int]] = {
    "top": (0, -1),
    "bottom": (0, 1),
    "left": (-1, 0),
    "right": (1, 0),
}


def attach_side(point: tuple[float, float], box: dict[str, float]) -> str | None:
    """Which side of `box` a boundary `point` sits on, or None if it isn't
    on the boundary (e.g. the shape has zero size)."""
    x, y = point
    x0, y0 = box["x"], box["y"]
    x1, y1 = x0 + box["width"], y0 + box["height"]
    if abs(y - y0) < 0.5:
        return "top"
    if abs(y - y1) < 0.5:
        return "bottom"
    if abs(x - x0) < 0.5:
        return "left"
    if abs(x - x1) < 0.5:
        return "right"
    return None


def segment_direction(a: tuple[float, float], b: tuple[float, float]) -> tuple[str, int] | None:
    """Which way a single orthogonal segment travels, as (axis, sign), or
    None for a degenerate (near zero-length) segment. Used to tell a
    genuine corner from a collinear pass-through waypoint (#56)."""
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    if abs(dx) < 0.5 and abs(dy) < 0.5:
        return None
    if abs(dx) >= abs(dy):
        return ("x", 1 if dx > 0 else -1)
    return ("y", 1 if dy > 0 else -1)


def count_real_bends(points: list[tuple[float, float]]) -> tuple[int, list[tuple[float, float]]]:
    """Count genuine direction changes in an orthogonal polyline, and
    separately return any collinear intermediate waypoint found along the
    way -- an intermediate point where the route does not actually turn.

    #46 already excluded exact duplicate waypoints from bend/length counts
    (a repeated point is a zero-length segment). This closes the same gap
    for a collinear-but-not-duplicate point: `max(0, len(points) - 2)`
    (the previous definition of total_bends, and of excess_turns' actual
    bend count) silently counted every intermediate waypoint as a bend
    whether or not the route actually turned there. Confirmed live in this
    engine's own output during #56's cross-engine metric audit: a
    MessageFlow with three collinear waypoints on a single straight line,
    inflating its bend count by one for no geometric reason. The risk is
    symmetric across engines -- any router that leaves a pass-through
    waypoint (grid-snapping, a channel-plan artifact, a merge of two
    formerly-distinct segments) would have its bend count inflated the same
    way, understating a competitor or overstating ourselves depending on
    which side it happens to occur."""
    bends = 0
    collinear: list[tuple[float, float]] = []
    for i in range(1, len(points) - 1):
        before = segment_direction(points[i - 1], points[i])
        after = segment_direction(points[i], points[i + 1])
        if before is None or after is None:
            continue  # a degenerate segment is counted separately (#46)
        if before == after:
            collinear.append(points[i])
        else:
            bends += 1
    return bends, collinear


def min_bend_count(
    source_point: tuple[float, float],
    source_side: str,
    target_point: tuple[float, float],
    target_side: str,
) -> int:
    """Fewest orthogonal bends an unobstructed route could use between two
    attach points, given only which side of each shape they leave/enter
    from: 0 for a straight shot, 1 for an L, 2 for a Z/U detour."""
    departure = _SIDE_OUTWARD_NORMAL[source_side]
    arrival = _SIDE_OUTWARD_NORMAL[target_side]
    # The route must be travelling opposite the target's outward normal to
    # enter through that side.
    required_final_direction = (-arrival[0], -arrival[1])
    if departure == required_final_direction:
        # Same travel direction throughout: a single straight segment only
        # works if the ports already line up on the cross-axis; otherwise a
        # Z/U-shaped detour (bend away, cross over, bend back) is needed.
        if departure[0] != 0:
            aligned = abs(source_point[1] - target_point[1]) < 0.5
        else:
            aligned = abs(source_point[0] - target_point[0]) < 0.5
        return 0 if aligned else 2
    if departure == (-required_final_direction[0], -required_final_direction[1]):
        # Directly opposite travel directions: the route must double back,
        # which always costs at least two bends.
        return 2
    # Perpendicular departure/arrival directions: a single corner suffices.
    return 1


def subprocess_parents(root: ET.Element) -> dict[str, str | None]:
    """Map BPMN elements to their immediate expanded-subprocess ancestor."""
    parents: dict[str, str | None] = {}

    def visit(parent: ET.Element, container_id: str | None) -> None:
        for child in parent:
            if not child.tag.startswith("{" + NS["bpmn"] + "}"):
                continue
            child_id = child.get("id")
            if child_id:
                parents.setdefault(child_id, container_id)
            visit(child, child_id if local_name(child.tag) == "subProcess" else container_id)

    for process in root.findall(q("bpmn", "process")):
        visit(process, None)
    return parents


def subprocess_ancestors(element_id: str | None, element_parents: dict[str, str | None]) -> set[str]:
    """Every expanded-subprocess ancestor of `element_id`, at any nesting
    depth -- subprocess_parents only records the immediate one (#64). Walks
    up the same map subprocess_parents already builds: element_parents maps
    a subprocess itself to *its* immediate parent, so repeatedly following
    it from a leaf reconstructs the full chain for free."""
    ancestors: set[str] = set()
    current = element_parents.get(element_id) if element_id else None
    while current and current not in ancestors:
        ancestors.add(current)
        current = element_parents.get(current)
    return ancestors


def lane_owners(root: ET.Element) -> dict[str, str]:
    """Map every flow node id listed in a lane's flowNodeRef to that lane's
    id (the innermost lane wins when lanes are nested)."""
    owners: dict[str, str] = {}
    for lane in root.iter(q("bpmn", "lane")):
        lane_id = lane.get("id", "")
        for ref in lane.findall(q("bpmn", "flowNodeRef")):
            node_id = (ref.text or "").strip()
            if node_id:
                owners[node_id] = lane_id
    return owners


def participant_owners(root: ET.Element) -> dict[str, str]:
    """Map every element id declared inside a participant's referenced
    process to that participant's id."""
    owners: dict[str, str] = {}
    processes_by_id = {process.get("id"): process for process in root.findall(q("bpmn", "process"))}
    for participant in root.iter(q("bpmn", "participant")):
        participant_id = participant.get("id", "")
        process = processes_by_id.get(participant.get("processRef", ""))
        if process is None:
            continue
        for element in process.iter():
            if not element.tag.startswith("{" + NS["bpmn"] + "}"):
                continue
            if local_name(element.tag) in {"process", "laneSet", "lane"}:
                continue
            element_id = element.get("id")
            if element_id:
                owners[element_id] = participant_id
    return owners


# Matches collision-repair.ts's SEGMENT_CLEARANCE: the engine treats a route
# passing within this distance of an obstacle as a near-miss, not clearance.
# Reused here as the radius within which a crossing at a shared endpoint's
# attach point is the expected "routes converge at this node" geometry
# rather than a real mid-route crossing (#48).
SHARED_ENDPOINT_CROSSING_EPSILON = 8.0


def orthogonal_crossing_point(
    a1: tuple[float, float], a2: tuple[float, float], b1: tuple[float, float], b2: tuple[float, float]
) -> tuple[float, float] | None:
    """Where two orthogonal segments cross, or None if they don't (parallel,
    or intersecting only at/beyond an endpoint)."""
    a_horizontal = abs(a1[1] - a2[1]) < 0.5
    b_horizontal = abs(b1[1] - b2[1]) < 0.5
    if a_horizontal == b_horizontal:
        return None
    h1, h2, v1, v2 = (a1, a2, b1, b2) if a_horizontal else (b1, b2, a1, a2)
    x = v1[0]
    y = h1[1]
    if min(h1[0], h2[0]) < x < max(h1[0], h2[0]) and min(v1[1], v2[1]) < y < max(v1[1], v2[1]):
        return (x, y)
    return None


def near_box(point: tuple[float, float], box: dict[str, float], epsilon: float) -> bool:
    x, y = point
    return (
        box["x"] - epsilon <= x <= box["x"] + box["width"] + epsilon
        and box["y"] - epsilon <= y <= box["y"] + box["height"] + epsilon
    )


def collect_metrics(path: Path) -> dict[str, object]:
    root = parse_xml(path)
    element_parents = subprocess_parents(root)
    element_lane = lane_owners(root)
    element_participant = participant_owners(root)
    element_types = {element.get("id"): local_name(element.tag) for element in root.iter() if element.get("id") and element.tag.startswith("{" + NS["bpmn"] + "}")}
    element_counts: dict[str, int] = {}
    named_external_targets: set[str] = set()
    flow_endpoints: dict[str, tuple[str | None, str | None]] = {}
    boundary_hosts: dict[str, str] = {}
    for element in root.iter():
        if not element.tag.startswith("{" + NS["bpmn"] + "}"):
            continue
        name = local_name(element.tag)
        element_counts[name] = element_counts.get(name, 0) + 1
        element_id = element.get("id")
        if element_id and element.get("name", "").strip() and (name.endswith("Event") or name.endswith("Gateway") or name in {"lane", "sequenceFlow", "messageFlow", "dataObjectReference", "dataStoreReference"}):
            named_external_targets.add(element_id)
        if name in {"sequenceFlow", "messageFlow", "association"}:
            flow_endpoints[element.get("id", "")] = (element.get("sourceRef"), element.get("targetRef"))
        if name == "boundaryEvent" and element_id:
            host = element.get("attachedToRef")
            if host:
                boundary_hosts[element_id] = host

    shapes: list[dict[str, object]] = []
    labels: list[dict[str, float]] = []
    label_targets: set[str] = set()
    node_label_gaps: dict[str, list[float]] = {"event": [], "gateway": []}
    invalid_label_bounds = 0
    edges: list[dict[str, object]] = []
    for plane in root.iter(q("bpmndi", "BPMNPlane")):
        plane_id = plane.get("id", "")
        for shape in plane.findall(q("bpmndi", "BPMNShape")):
            bounds = bounds_from(shape)
            if bounds is None:
                continue
            target_id = shape.get("bpmnElement", "")
            label = label_bounds_from(shape)
            if label:
                if not valid_bounds(label):
                    invalid_label_bounds += 1
                label["_plane"] = plane_id  # type: ignore[assignment]
                label["_target"] = target_id  # type: ignore[assignment]
                labels.append(label)
                label_targets.add(target_id)
                element_type = element_types.get(target_id, "")
                if element_type.endswith("Event"):
                    node_label_gaps["event"].append(
                        round(
                            min(
                                abs(label["y"] - (bounds["y"] + bounds["height"])),
                                abs(bounds["y"] - (label["y"] + label["height"])),
                            ),
                            2,
                        )
                    )
                elif element_type.endswith("Gateway"):
                    node_label_gaps["gateway"].append(
                        round(
                            min(
                                abs(label["y"] - (bounds["y"] + bounds["height"])),
                                abs(bounds["y"] - (label["y"] + label["height"])),
                            ),
                            2,
                        )
                    )
            shapes.append({"id": shape.get("id", ""), "plane": plane_id, "bpmnElement": target_id, "type": element_types.get(target_id, ""), "bounds": bounds})
        for edge in plane.findall(q("bpmndi", "BPMNEdge")):
            points = [(float(point.get("x", "0")), float(point.get("y", "0"))) for point in edge.findall(q("di", "waypoint"))]
            label = label_bounds_from(edge)
            target_id = edge.get("bpmnElement", "")
            if label:
                if not valid_bounds(label):
                    invalid_label_bounds += 1
                label["_plane"] = plane_id  # type: ignore[assignment]
                label["_target"] = target_id  # type: ignore[assignment]
                labels.append(label)
                label_targets.add(target_id)
            edges.append({"id": edge.get("id", ""), "plane": plane_id, "bpmnElement": target_id, "points": points})

    canvas_points: list[tuple[float, float]] = []
    for shape in shapes:
        b = shape["bounds"]  # type: ignore[index]
        canvas_points.extend([(b["x"], b["y"]), (b["x"] + b["width"], b["y"] + b["height"])])
    for edge in edges:
        canvas_points.extend(edge["points"])  # type: ignore[arg-type]
    if canvas_points:
        min_x = min(point[0] for point in canvas_points)
        min_y = min(point[1] for point in canvas_points)
        max_x = max(point[0] for point in canvas_points)
        max_y = max(point[1] for point in canvas_points)
        canvas = {"x": min_x, "y": min_y, "width": max_x - min_x, "height": max_y - min_y}
    else:
        canvas = {"x": 0, "y": 0, "width": 0, "height": 0}

    shape_overlaps = 0
    shape_overlap_area = 0.0
    for i, first in enumerate(shapes):
        first_bounds = first["bounds"]  # type: ignore[index]
        first_id = str(first["bpmnElement"])
        for second in shapes[i + 1 :]:
            if first["plane"] != second["plane"]:
                continue
            second_id = str(second["bpmnElement"])
            second_bounds = second["bounds"]  # type: ignore[index]
            if first["type"] in CONTAINER_TYPES and contains(first_bounds, second_bounds):
                continue
            if second["type"] in CONTAINER_TYPES and contains(second_bounds, first_bounds):
                continue
            # A boundary event is deliberately placed straddling its host
            # activity's border; that overlap is required BPMN notation, not
            # a layout defect.
            if boundary_hosts.get(first_id) == second_id or boundary_hosts.get(second_id) == first_id:
                continue
            area = box_overlap(first_bounds, second_bounds)
            if area > 0:
                shape_overlaps += 1
                shape_overlap_area += area

    shapes_by_plane_id = {(shape["plane"], shape["bpmnElement"]): shape for shape in shapes}

    def owning_containers(node_id: str) -> list[tuple[str, str]]:
        # A subprocess child is laid out in its container's own internal
        # coordinate space, not the outer lane/participant's: check it only
        # against its immediate subprocess, even if a lane's flowNodeRef
        # also (redundantly, per BPMN's permissive schema) lists it.
        subprocess_id = element_parents.get(node_id)
        if subprocess_id:
            return [("subProcess", subprocess_id)]
        result: list[tuple[str, str]] = []
        lane_id = element_lane.get(node_id)
        if lane_id:
            result.append(("lane", lane_id))
        participant_id = element_participant.get(node_id)
        if participant_id:
            result.append(("participant", participant_id))
        return result

    def border_distance(outer: dict[str, float], inner: dict[str, float]) -> float:
        return min(
            inner["x"] - outer["x"],
            (outer["x"] + outer["width"]) - (inner["x"] + inner["width"]),
            inner["y"] - outer["y"],
            (outer["y"] + outer["height"]) - (inner["y"] + inner["height"]),
        )

    node_containment_violations = 0
    node_containment_violation_details: list[dict[str, str]] = []
    padding_by_type: dict[str, list[float]] = {}
    for shape in shapes:
        if shape["type"] in CONTAINER_TYPES:
            continue
        node_id = str(shape["bpmnElement"])
        node_bounds = shape["bounds"]  # type: ignore[index]
        for kind, owner_id in owning_containers(node_id):
            owner_shape = shapes_by_plane_id.get((shape["plane"], owner_id))
            if not owner_shape:
                continue
            owner_bounds = owner_shape["bounds"]  # type: ignore[index]
            if not contains(owner_bounds, node_bounds):  # type: ignore[arg-type]
                node_containment_violations += 1
                node_containment_violation_details.append(
                    {"node": node_id, "container": owner_id, "container_type": kind}
                )
            else:
                padding_by_type.setdefault(kind, []).append(border_distance(owner_bounds, node_bounds))  # type: ignore[arg-type]

    label_containment_violations = 0
    label_containment_violation_details: list[dict[str, str]] = []
    for label in labels:
        label_target = str(label.get("_target", ""))
        if not label_target:
            continue
        for kind, owner_id in owning_containers(label_target):
            owner_shape = shapes_by_plane_id.get((label.get("_plane"), owner_id))
            if not owner_shape:
                continue
            if not contains(owner_shape["bounds"], label):  # type: ignore[arg-type]
                label_containment_violations += 1
                label_containment_violation_details.append(
                    {"label": label_target, "container": owner_id, "container_type": kind}
                )

    container_padding = {
        kind: {
            "count": len(values),
            "min": round(min(values), 2) if values else None,
            "max": round(max(values), 2) if values else None,
            "avg": round(sum(values) / len(values), 2) if values else None,
        }
        for kind, values in padding_by_type.items()
    }

    label_overlaps = 0
    for i, first in enumerate(labels):
        for second in labels[i + 1 :]:
            if first.get("_plane") != second.get("_plane"):
                continue
            if box_overlap(first, second) > 0:
                label_overlaps += 1

    label_shape_intersections = 0
    label_edge_intersections = 0
    label_shape_intersection_details: list[dict[str, str]] = []
    label_edge_intersection_details: list[dict[str, str]] = []
    for label in labels:
        label_target = str(label.get("_target", ""))
        for shape in shapes:
            if shape["plane"] != label.get("_plane") or shape["bpmnElement"] == label_target:
                continue
            if shape["type"] in CONTAINER_TYPES and contains(shape["bounds"], label):  # type: ignore[arg-type]
                continue
            if box_overlap(label, shape["bounds"]) > 0:  # type: ignore[arg-type]
                label_shape_intersections += 1
                label_shape_intersection_details.append(
                    {"label": label_target, "shape": str(shape["bpmnElement"])}
                )
        for edge in edges:
            if edge["plane"] != label.get("_plane") or edge["bpmnElement"] == label_target:
                continue
            if any(segment_intersects_box(a, b, label) for a, b in zip(edge["points"], edge["points"][1:])):  # type: ignore[arg-type]
                label_edge_intersections += 1
                label_edge_intersection_details.append(
                    {"label": label_target, "edge": str(edge["bpmnElement"])}
                )

    edge_crossings = 0
    edge_shape_intersections = 0
    edge_container_intersections = 0
    invalid_edge_attachments = 0
    edge_crossing_details: list[dict[str, str]] = []
    edge_shape_intersection_details: list[dict[str, str]] = []
    edge_container_intersection_details: list[dict[str, str]] = []
    invalid_edge_attachment_details: list[dict[str, str]] = []
    total_bends = 0
    total_manhattan = 0.0
    non_orthogonal_segments = 0
    non_lattice_segments = 0
    max_lattice_remainder = 0.0
    degenerate_waypoints = 0
    degenerate_waypoint_details: list[dict[str, object]] = []
    collinear_waypoints = 0
    collinear_waypoint_details: list[dict[str, object]] = []
    horizontal_flow_gaps: list[float] = []
    excess_turns_total = 0
    excess_turns_unscored = 0
    excess_turns_unscored_details: list[str] = []
    excess_turn_details: list[dict[str, object]] = []
    detour_ratios: list[float] = []
    shapes_by_plane_target = {
        (shape["plane"], shape["bpmnElement"]): shape
        for shape in shapes
        if shape["type"] not in CONTAINER_TYPES
    }
    subprocess_shapes = [shape for shape in shapes if shape["type"] == "subProcess"]
    lane_participant_shapes = [shape for shape in shapes if shape["type"] in ("lane", "participant")]

    def container_owns_endpoint(kind: str, container_id: str, endpoint: str | None) -> bool:
        if not endpoint:
            return False
        if kind == "lane":
            return element_lane.get(endpoint) == container_id
        if kind == "participant":
            return element_participant.get(endpoint) == container_id
        return False

    def endpoint_container_id(kind: str, endpoint: str | None) -> str | None:
        if not endpoint:
            return None
        if kind == "lane":
            return element_lane.get(endpoint)
        if kind == "participant":
            return element_participant.get(endpoint)
        return None
    for edge in edges:
        source_id, target_id = flow_endpoints.get(edge["bpmnElement"], (None, None))  # type: ignore[arg-type]
        source = shapes_by_plane_target.get((edge["plane"], source_id))
        target = shapes_by_plane_target.get((edge["plane"], target_id))
        if not source or not target:
            continue
        source_bounds = source["bounds"]  # type: ignore[index]
        target_bounds = target["bounds"]  # type: ignore[index]
        source_center_y = source_bounds["y"] + source_bounds["height"] / 2
        target_center_y = target_bounds["y"] + target_bounds["height"] / 2
        if abs(source_center_y - target_center_y) >= 0.5 or target_bounds["x"] < source_bounds["x"]:
            continue
        if any(
            other["plane"] == edge["plane"]
            and other["id"] not in {source["id"], target["id"]}
            and other["type"] not in CONTAINER_TYPES
            and abs(
                (other["bounds"]["y"] + other["bounds"]["height"] / 2)  # type: ignore[index]
                - source_center_y
            )
            < 0.5
            and other["bounds"]["x"] >= source_bounds["x"] + source_bounds["width"]  # type: ignore[index]
            and other["bounds"]["x"] + other["bounds"]["width"] <= target_bounds["x"]  # type: ignore[index]
            for other in shapes
        ):
            continue
        horizontal_flow_gaps.append(
            round(target_bounds["x"] - (source_bounds["x"] + source_bounds["width"]), 2)
        )
    for edge in edges:
        points = edge["points"]  # type: ignore[assignment]
        real_bends, collinear_points = count_real_bends(points)  # type: ignore[arg-type]
        total_bends += real_bends
        for point in collinear_points:
            collinear_waypoints += 1
            collinear_waypoint_details.append(
                {"edge": str(edge["bpmnElement"]), "point": [round(point[0], 2), round(point[1], 2)]}
            )
        source_id, target_id = flow_endpoints.get(edge["bpmnElement"], (None, None))  # type: ignore[arg-type]
        source = shapes_by_plane_target.get((edge["plane"], source_id))
        target = shapes_by_plane_target.get((edge["plane"], target_id))
        source_bounds = source["bounds"] if source else None  # type: ignore[index]
        target_bounds = target["bounds"] if target else None  # type: ignore[index]
        endpoints = {source_id, target_id}
        if source and points and not point_on_boundary(points[0], source_bounds):
            invalid_edge_attachments += 1
            invalid_edge_attachment_details.append({"edge": str(edge["bpmnElement"]), "end": "source"})
        if target and points and not point_on_boundary(points[-1], target_bounds):
            invalid_edge_attachments += 1
            invalid_edge_attachment_details.append({"edge": str(edge["bpmnElement"]), "end": "target"})
        edge_manhattan = 0.0
        for a, b in zip(points, points[1:]):
            segment_length = abs(a[0] - b[0]) + abs(a[1] - b[1])
            total_manhattan += segment_length
            edge_manhattan += segment_length
            if segment_length < 0.5:
                # A repeated (or near-repeated) consecutive waypoint pair
                # contributes no geometry: it inflates total_bends for free
                # and, since both coordinate deltas are ~0, incidentally
                # passes the orthogonal check below rather than failing it
                # (#46).
                degenerate_waypoints += 1
                degenerate_waypoint_details.append(
                    {"edge": str(edge["bpmnElement"]), "point": [round(a[0], 2), round(a[1], 2)]}
                )
            if abs(a[0] - b[0]) >= 0.5 and abs(a[1] - b[1]) >= 0.5:
                non_orthogonal_segments += 1
            remainder = segment_length % ROUTE_UNIT
            distance_to_lattice = min(remainder, ROUTE_UNIT - remainder) if segment_length else 0
            if distance_to_lattice > 0.5:
                non_lattice_segments += 1
                max_lattice_remainder = max(max_lattice_remainder, distance_to_lattice)
            for shape in shapes:
                if shape["plane"] != edge["plane"]:
                    continue
                if shape["bpmnElement"] in endpoints or shape["type"] in CONTAINER_TYPES:
                    continue
                if segment_intersects_box(a, b, shape["bounds"]):  # type: ignore[arg-type]
                    edge_shape_intersections += 1
                    edge_shape_intersection_details.append(
                        {
                            "edge": str(edge["bpmnElement"]),
                            "shape": str(shape["bpmnElement"]),
                        }
                    )
            for container in subprocess_shapes:
                if container["plane"] != edge["plane"]:
                    continue
                container_id = str(container["bpmnElement"])
                if container_id in endpoints:
                    continue
                # A descendant at *any* depth is internal to this container,
                # not just an immediate child -- element_parents only records
                # the immediate parent, so this walks the chain (#64). Each
                # ancestor level still gets its own bounds check below (the
                # loop visits every subprocess shape), so the nearest
                # container -- the one that actually bounds the edge -- is
                # the one whose check can actually fail.
                owned = [
                    container_id in subprocess_ancestors(endpoint, element_parents) for endpoint in endpoints if endpoint
                ]
                if owned and all(owned):
                    # Wholly internal to this container: every waypoint must
                    # still stay inside it -- a route between two of its own
                    # children leaving the container's box is a real defect,
                    # not something a blanket exemption should hide (#26).
                    if not point_within(a, container["bounds"]) or not point_within(  # type: ignore[arg-type]
                        b, container["bounds"]  # type: ignore[arg-type]
                    ):
                        edge_container_intersections += 1
                        edge_container_intersection_details.append(
                            {"edge": str(edge["bpmnElement"]), "container": container_id}
                        )
                    continue
                if any(owned):
                    # One endpoint belongs to this container (e.g. a boundary
                    # event's own outgoing flow attaches on its border) --
                    # crossing the boundary here is expected, not a defect.
                    continue
                if segment_intersects_box(a, b, container["bounds"]):  # type: ignore[arg-type]
                    edge_container_intersections += 1
                    edge_container_intersection_details.append(
                        {"edge": str(edge["bpmnElement"]), "container": container_id}
                    )
            # Pools and lanes: a route may legitimately pass through the
            # participant/lane band it or its endpoints live in (that is the
            # interior, not a boundary crossing) but not through one that
            # neither endpoint belongs to (see #11).
            for container in lane_participant_shapes:
                if container["plane"] != edge["plane"]:
                    continue
                kind = str(container["type"])
                container_id = str(container["bpmnElement"])
                if container_id in endpoints:
                    continue
                if any(container_owns_endpoint(kind, container_id, endpoint) for endpoint in endpoints):
                    continue
                if segment_intersects_box(a, b, container["bounds"]):  # type: ignore[arg-type]
                    source_container_id = endpoint_container_id(kind, source_id)
                    target_container_id = endpoint_container_id(kind, target_id)
                    source_container = (
                        shapes_by_plane_id.get((edge["plane"], source_container_id)) if source_container_id else None
                    )
                    target_container = (
                        shapes_by_plane_id.get((edge["plane"], target_container_id)) if target_container_id else None
                    )
                    exempt = bool(source_container and target_container) and is_monotonic_lane_crossing(
                        points,  # type: ignore[arg-type]
                        container["bounds"],  # type: ignore[arg-type]
                        source_container["bounds"],  # type: ignore[index,arg-type]
                        target_container["bounds"],  # type: ignore[index,arg-type]
                    )
                    if not exempt:
                        edge_container_intersections += 1
                        edge_container_intersection_details.append(
                            {"edge": str(edge["bpmnElement"]), "container": container_id}
                        )
        if points and len(points) >= 2 and source_bounds and target_bounds:
            source_side = attach_side(points[0], source_bounds)
            target_side = attach_side(points[-1], target_bounds)
            if source_side and target_side:
                baseline_bends = min_bend_count(points[0], source_side, points[-1], target_side)
                excess = max(0, real_bends - baseline_bends)
                if excess > 0:
                    excess_turns_total += excess
                    excess_turn_details.append({"edge": str(edge["bpmnElement"]), "excess_turns": excess})
            else:
                # attach_side found neither endpoint sitting on its node's
                # boundary -- no baseline could be computed for this edge, so
                # it contributes neither to excess_turns_total nor silently
                # to a false 0 (#56 item 3: a metric that cannot be computed
                # for an edge must be visibly excluded, not folded into the
                # count as if it scored perfectly).
                excess_turns_unscored += 1
                excess_turns_unscored_details.append(str(edge["bpmnElement"]))
            port_distance = abs(points[0][0] - points[-1][0]) + abs(points[0][1] - points[-1][1])
            if port_distance > 0.5:
                detour_ratios.append(edge_manhattan / port_distance)
    excess_turn_details.sort(key=lambda detail: -int(detail["excess_turns"]))  # type: ignore[arg-type]
    for i, first in enumerate(edges):
        first_points = first["points"]  # type: ignore[assignment]
        first_endpoints = {value for value in flow_endpoints.get(first["bpmnElement"], (None, None)) if value}  # type: ignore[arg-type]
        for second in edges[i + 1 :]:
            if first["plane"] != second["plane"]:
                continue
            second_endpoints = {value for value in flow_endpoints.get(second["bpmnElement"], (None, None)) if value}  # type: ignore[arg-type]
            # Two flows sharing a source or target legitimately meet at that
            # node -- but sharing an endpoint says nothing about what the
            # routes do in between, so only a crossing that actually falls
            # near the shared node's own shape is the expected "routes
            # converge here" geometry (#48); a crossing anywhere else along
            # either route is a real readability defect.
            shared_bounds = [
                shapes_by_plane_id[(first["plane"], shared_id)]["bounds"]  # type: ignore[index]
                for shared_id in first_endpoints & second_endpoints
                if (first["plane"], shared_id) in shapes_by_plane_id
            ]
            second_points = second["points"]  # type: ignore[assignment]
            for a1, a2 in zip(first_points, first_points[1:]):
                for b1, b2 in zip(second_points, second_points[1:]):
                    crossing = orthogonal_crossing_point(a1, a2, b1, b2)
                    if crossing is None:
                        continue
                    if any(near_box(crossing, bounds, SHARED_ENDPOINT_CROSSING_EPSILON) for bounds in shared_bounds):  # type: ignore[arg-type]
                        continue
                    edge_crossings += 1
                    edge_crossing_details.append(
                        {
                            "first": str(first["bpmnElement"]),
                            "second": str(second["bpmnElement"]),
                        }
                    )

    grid_deviations: list[float] = []
    for shape in shapes:
        if shape["type"] in CONTAINER_TYPES:
            continue
        b = shape["bounds"]  # type: ignore[index]
        center_x = b["x"] + b["width"] / 2
        grid_deviations.append(abs(center_x - (75 + round((center_x - 75) / 120) * 120)))

    diagrams = len(list(root.iter(q("bpmndi", "BPMNDiagram"))))
    covered = sorted(named_external_targets.intersection(label_targets))
    missing = sorted(named_external_targets.difference(label_targets))
    node_label_gap_stats = {}
    for kind, values in node_label_gaps.items():
        node_label_gap_stats[kind] = {
            "count": len(values),
            "min": min(values) if values else None,
            "max": max(values) if values else None,
            "avg": round(sum(values) / len(values), 2) if values else None,
        }
    return {
        "file": str(path),
        "sha256": sha256_file(path),
        "semantic": {
            "element_counts": dict(sorted(element_counts.items())),
            "sequence_flows": element_counts.get("sequenceFlow", 0),
            "message_flows": element_counts.get("messageFlow", 0),
            "lanes": element_counts.get("lane", 0),
            "data_references": element_counts.get("dataObjectReference", 0) + element_counts.get("dataStoreReference", 0),
        },
        "layout": {
            "diagrams": diagrams,
            "shapes": len(shapes),
            "edges": len(edges),
            "labels": len(labels),
            "canvas": canvas,
            "canvas_area": round(canvas["width"] * canvas["height"], 2),
            "shape_overlaps": shape_overlaps,
            "shape_overlap_area": round(shape_overlap_area, 2),
            "node_containment_violations": node_containment_violations,
            "node_containment_violation_details": node_containment_violation_details,
            "label_containment_violations": label_containment_violations,
            "label_containment_violation_details": label_containment_violation_details,
            "container_padding": container_padding,
            "label_overlaps": label_overlaps,
            "label_shape_intersections": label_shape_intersections,
            "label_edge_intersections": label_edge_intersections,
            "invalid_label_bounds": invalid_label_bounds,
            "edge_crossings": edge_crossings,
            "edge_shape_intersections": edge_shape_intersections,
            "edge_container_intersections": edge_container_intersections,
            "invalid_edge_attachments": invalid_edge_attachments,
            "edge_crossing_details": edge_crossing_details,
            "edge_shape_intersection_details": edge_shape_intersection_details,
            "edge_container_intersection_details": edge_container_intersection_details,
            "invalid_edge_attachment_details": invalid_edge_attachment_details,
            "label_shape_intersection_details": label_shape_intersection_details,
            "label_edge_intersection_details": label_edge_intersection_details,
            "total_bends": total_bends,
            "total_manhattan_length": round(total_manhattan, 2),
            "non_orthogonal_segments": non_orthogonal_segments,
            "degenerate_waypoints": degenerate_waypoints,
            "degenerate_waypoint_details": degenerate_waypoint_details,
            "collinear_waypoints": collinear_waypoints,
            "collinear_waypoint_details": collinear_waypoint_details,
            "excess_turns": excess_turns_total,
            "excess_turn_details": excess_turn_details,
            "excess_turns_unscored": excess_turns_unscored,
            "excess_turns_unscored_details": excess_turns_unscored_details,
            "detour_ratio": {
                "count": len(detour_ratios),
                "min": round(min(detour_ratios), 2) if detour_ratios else None,
                "max": round(max(detour_ratios), 2) if detour_ratios else None,
                "avg": round(sum(detour_ratios) / len(detour_ratios), 2) if detour_ratios else None,
            },
            "route_lattice": {
                "unit": ROUTE_UNIT,
                "non_multiple_segments": non_lattice_segments,
                "max_remainder": round(max_lattice_remainder, 2),
            },
            "horizontal_flow_gap": {
                "count": len(horizontal_flow_gaps),
                "min": min(horizontal_flow_gaps) if horizontal_flow_gaps else None,
                "max": max(horizontal_flow_gaps) if horizontal_flow_gaps else None,
                "avg": round(sum(horizontal_flow_gaps) / len(horizontal_flow_gaps), 2) if horizontal_flow_gaps else None,
                # How much horizontal spacing between tracks varies within one
                # diagram (max - min); an aesthetic preference (#55), not a
                # validity concern -- 0 means every gap is identical.
                "consistency": round(max(horizontal_flow_gaps) - min(horizontal_flow_gaps), 2)
                if horizontal_flow_gaps
                else None,
            },
            "grid_center_x_deviation_avg": round(sum(grid_deviations) / len(grid_deviations), 2) if grid_deviations else 0,
            "grid_center_x_deviation_max": round(max(grid_deviations), 2) if grid_deviations else 0,
            "node_label_gap": node_label_gap_stats,
            "named_label_coverage": {"covered": len(covered), "missing": len(missing), "missing_ids": missing},
        },
    }


def run_command(command: list[str], purpose: str) -> None:
    executable = shutil.which(command[0]) if command else None
    if not executable:
        raise SystemExit(f"required command for {purpose!r} not found: {command[0] if command else '<empty>'}")
    completed = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if completed.returncode != 0:
        raise SystemExit(
            f"{purpose} failed with exit code {completed.returncode}: {' '.join(shlex.quote(part) for part in command)}\n"
            f"stdout:\n{completed.stdout}\n"
            f"stderr:\n{completed.stderr}"
        )


def run_engine_command(command: list[str], purpose: str) -> str | None:
    """Like run_command, but returns an error description instead of raising
    when the command is missing or fails. An N-way engine comparison must
    degrade a misbehaving or absent third-party engine to an empty column
    for the fixtures it fails on, never abort the whole run for every other
    engine and fixture (#53 item 4)."""
    executable = shutil.which(command[0]) if command else None
    if not executable:
        return f"command not found on PATH: {command[0] if command else '<empty>'}"
    completed = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        return f"{purpose} failed with exit code {completed.returncode}" + (f": {detail}" if detail else "")
    return None


def run_command_if_available(command: list[str], purpose: str) -> bool:
    """Like run_command, but returns False instead of raising when the
    command itself is missing from PATH (a real failure of an available
    command still raises). Lets selftest verify the layout engine when it
    can, while still working without external dependencies when it can't."""
    executable = shutil.which(command[0]) if command else None
    if not executable:
        return False
    run_command(command, purpose)
    return True


def split_command(value: str) -> list[str]:
    parts = shlex.split(value)
    if not parts:
        raise SystemExit("command may not be empty")
    return parts


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def resolve_commit_sha() -> str:
    """Best-effort git commit SHA for the checkout this report was rendered
    from. A published comparison must show the measurement date and commit
    so a reader can check whether a favourable trend coincided with a
    metric edit (#58) -- "unknown" (never a stale or fabricated value) when
    git is unavailable or this isn't a checkout at all."""
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_root(),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode == 0:
        return completed.stdout.strip()
    return "unknown"


def resolve_dist_index() -> Path | None:
    """The built layout engine, importable directly by `node` -- no CLI, no
    nix. Exists once `npm run build` has run inside packages/bpmn-auto-layout;
    None when the package has not been built here."""
    candidate = repo_root() / "packages" / "bpmn-auto-layout" / "dist" / "index.js"
    return candidate if candidate.is_file() else None


def write_layout_via_node_script(dist_index: Path) -> Path:
    """Write (to a fresh temp file the caller must clean up) a small ESM
    script that imports layoutProcess from the built package directly and
    transforms every file named on argv in place. Shared by layout_via_node
    (batches every target in one process) and the report command's "ours"
    fallback (invoked once per file, same calling convention as an external
    --layout-command)."""
    script = (
        'import { readFile, writeFile } from "node:fs/promises";\n'
        f"import {{ layoutProcess }} from {json.dumps(dist_index.resolve().as_posix())};\n"
        "for (const file of process.argv.slice(2)) {\n"
        '  const xml = await readFile(file, "utf8");\n'
        "  await writeFile(file, await layoutProcess(xml));\n"
        "}\n"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False, encoding="utf8") as handle:
        handle.write(script)
        return Path(handle.name)


def layout_via_node(dist_index: Path, targets: list[Path]) -> None:
    """Lay out every file in `targets` in place by importing layoutProcess
    from the built package directly, bypassing the bpmn-auto-layout CLI
    wrapper flake.nix defines. Works in any environment with the package
    already built -- a plain CI runner, a container, an agent working
    directly in the repo -- not only inside `nix develop` (#43)."""
    node = shutil.which("node")
    if not node:
        raise SystemExit("node not found on PATH; cannot run the layout engine directly")
    script_path = write_layout_via_node_script(dist_index)
    try:
        completed = subprocess.run(
            [node, str(script_path), *[str(target) for target in targets]],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    finally:
        script_path.unlink(missing_ok=True)
    if completed.returncode != 0:
        raise SystemExit(
            f"layout engine (node against {dist_index}) failed with exit code {completed.returncode}:\n"
            f"stdout:\n{completed.stdout}\n"
            f"stderr:\n{completed.stderr}"
        )


def layout_fixtures(targets: list[Path], layout_command: list[str], structure_only: bool, purpose: str) -> bool:
    """Lay out every file in `targets` in place, preferring (in order) the
    configured --layout-command if it is on PATH, then the built engine run
    directly through node, then -- only when the caller explicitly opted
    into a degraded check via --structure-only -- doing nothing and letting
    the caller validate persisted DI as-is. Any other case where no engine
    could be found is a hard failure: a check that cannot run its main
    assertion has not passed (#43), so it must not exit 0.

    Returns whether the layout engine actually ran (freshly generated
    output) as opposed to being skipped."""
    executable = shutil.which(layout_command[0]) if layout_command else None
    if executable:
        for target in targets:
            run_command(layout_command + [str(target)], f"{purpose} {target.name}")
        return True
    dist_index = resolve_dist_index()
    if dist_index:
        layout_via_node(dist_index, targets)
        return True
    if structure_only:
        return False
    raise SystemExit(
        f"{purpose}: no layout engine available -- {shlex.join(layout_command)!r} is not on PATH and "
        f"{repo_root() / 'packages' / 'bpmn-auto-layout' / 'dist' / 'index.js'} does not exist "
        "(run `npm run build` in packages/bpmn-auto-layout, or enter `nix develop`). "
        "Pass --structure-only to validate persisted DI as-is instead."
    )


def parse_engine_specs(specs: list[str], default_layout_command: str) -> dict[str, list[str]]:
    """Turn repeated --engine NAME=COMMAND options into an ordered
    name -> command mapping, with our own engine ("ours") always present
    and first -- from --layout-command by default, or overridden by an
    explicit --engine ours=... spec -- so zero --engine flags keeps
    today's behaviour (source vs our own output) and any additional
    --engine entries are baselines layered on top (#53)."""
    engines: dict[str, list[str]] = {"ours": split_command(default_layout_command)}
    for spec in specs:
        name, sep, command = spec.partition("=")
        name = name.strip()
        if not sep or not name:
            raise SystemExit(f"--engine expects NAME=COMMAND, got: {spec!r}")
        engines[name] = split_command(command)
    return engines


def resolve_engine_command(name: str, command: list[str]) -> list[str]:
    """Resolve an engine's layout command for the report's own invocation
    convention (`command + [file]`, in place). Falls back to running the
    locally built package directly through node when this is our own engine
    and its configured command isn't on PATH -- the same fallback
    selftest/regression rely on (#43), extended here so N-way comparisons
    also work without nix or a globally installed CLI."""
    if name == "ours" and not (command and shutil.which(command[0])):
        dist_index = resolve_dist_index()
        if dist_index:
            node = shutil.which("node")
            if node:
                return [node, str(write_layout_via_node_script(dist_index))]
    return command


def ours_version() -> str:
    """The version to record for our own engine, regardless of how it was
    actually invoked (CLI on PATH or the node/dist fallback) -- the package
    manifest is the one source of truth for what "ours" means (#53, #54)."""
    package_json = repo_root() / "packages" / "bpmn-auto-layout" / "package.json"
    try:
        return json.loads(package_json.read_text(encoding="utf8"))["version"]
    except (OSError, KeyError, json.JSONDecodeError):
        return "unknown"


def installed_npm_package_version(node_modules_root: Path, package: str) -> str | None:
    """Read the resolved version of `package` from a node_modules tree that
    has already been `npm install`-ed, e.g. tools/upstream-baseline's pinned
    bpmn-auto-layout@1.3.0 (#54) -- the manifest under node_modules is what
    was actually installed, which is what a reproducible comparison must
    record, not just what package.json asked for."""
    package_json = node_modules_root / "node_modules" / package / "package.json"
    try:
        return json.loads(package_json.read_text(encoding="utf8"))["version"]
    except (OSError, KeyError, json.JSONDecodeError):
        return None


def engine_version(name: str, command: list[str]) -> str:
    """Best-effort resolved version for an engine, so a published comparison
    records what was actually measured (#53, #54). A moving, unpinned
    command (a bare package name with no @version) resolves to "unknown"
    rather than a guess -- an unreproducible comparison should look
    unreproducible, not silently pass as pinned."""
    if name == "ours":
        return ours_version()
    for part in command:
        match = re.search(r"@(\d[\w.\-]*)$", part)
        if match:
            return match.group(1)
    # A wrapper script invoked by path (tools/upstream-baseline/run.mjs, the
    # pinned bpmn-io/bpmn-auto-layout baseline) carries no @version in the
    # command itself -- resolve it from what was actually npm-installed
    # alongside the script instead.
    for part in command:
        script = Path(part)
        if script.suffix == ".mjs" and script.is_file():
            version = installed_npm_package_version(script.parent, "bpmn-auto-layout")
            if version:
                return version
    return "unknown"


def di_geometry_signature(xml: str) -> list[tuple[str | None, ...]]:
    """Every DI coordinate value in document order, as a signature that is
    independent of formatting/whitespace/attribute order -- used to detect
    a fixture whose committed DI was seeded directly from an engine's own
    output rather than authored independently (#62). Returns [] on unparsable
    input rather than raising: an outer caller decides what that means."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    signature: list[tuple[str | None, ...]] = []
    for element in root.iter():
        tag = local_name(element.tag)
        if tag == "Bounds":
            signature.append(("Bounds", element.get("x"), element.get("y"), element.get("width"), element.get("height")))
        elif tag == "waypoint":
            signature.append(("waypoint", element.get("x"), element.get("y")))
    return signature


# A fixture seeded from an engine run stays detectable even after an
# unrelated engine fix nudges a handful of coordinates -- exact identity is
# the strong signal, but requiring it would let one routing tweak quietly
# un-flag a fixture that was never independently authored in the first
# place (confirmed while building this: nested-subprocess-exceptions.bpmn,
# named as self-seeded in #62, fell to 73/77 matching entries after this
# session's own #59 routing fix -- still obviously the same seed run, not a
# coincidence between two independent authors).
NEAR_SEEDED_THRESHOLD = 0.85


def original_seeded_reason(original_xml: str, engine_xml: str) -> str | None:
    """None if `original_xml`'s committed DI looks independently authored;
    otherwise a human-readable reason it doesn't (#62): its geometry is
    identical, or nearly identical, to a fresh run of this same engine on
    the same semantics. A source with no DI at all (empty signature) is
    never "seeded" -- just DI-less; source_has_di already excludes that
    case before this is ever called, but empty-vs-empty would otherwise
    compare as a 100% match and misreport every DI-less pair."""
    original_signature = di_geometry_signature(original_xml)
    if not original_signature:
        return None
    engine_signature = di_geometry_signature(engine_xml)
    if original_signature == engine_signature:
        return "seeded from this engine, not an independent reference"
    if len(original_signature) == len(engine_signature) and original_signature:
        matching = sum(1 for a, b in zip(original_signature, engine_signature) if a == b)
        if matching / len(original_signature) >= NEAR_SEEDED_THRESHOLD:
            return "nearly identical to this engine's own output, likely seeded from an earlier run -- not an independent reference"
    return None


def source_has_di(source: Path) -> bool:
    """Whether `source` already carries diagram interchange -- used to skip
    the "original" comparison column for a source that has none, per #53's
    "the source diagram stays column 0 when it has DI"."""
    try:
        return "BPMNPlane" in source.read_text(encoding="utf8", errors="ignore")
    except OSError:
        return False


def clear_reports(output_dir: str) -> None:
    root = Path(output_dir)
    if not root.exists():
        return
    for report in root.glob("report-*"):
        if report.is_dir() and not report.is_symlink():
            shutil.rmtree(report)


def render_report(args: argparse.Namespace) -> Path:
    """Render an N-way comparison: the source diagram (when it carries DI)
    alongside every configured engine's output, scored identically (#53).
    Zero --engine flags keeps today's behaviour of one column, our own
    engine, named "ours"."""
    report_root = Path(args.output_dir)
    report_root.mkdir(parents=True, exist_ok=True)
    if args.clear_output:
        clear_reports(args.output_dir)
    workdir = Path(tempfile.mkdtemp(prefix="report-", dir=report_root))
    inputs = [Path(path) for path in args.inputs]
    if not inputs:
        inputs = [Path("fixtures") / filename for filename in sorted(persisted_fixtures())]
    image_command = split_command(args.image_command)

    raw_engine_commands = parse_engine_specs(getattr(args, "engines", []) or [], args.layout_command)
    engine_versions = {name: engine_version(name, command) for name, command in raw_engine_commands.items()}
    resolved_commands = {name: resolve_engine_command(name, command) for name, command in raw_engine_commands.items()}
    cleanup_paths = [
        Path(command[1])
        for name, command in resolved_commands.items()
        if command != raw_engine_commands[name] and len(command) > 1
    ]

    try:
        entries: list[dict[str, object]] = []
        for index, source in enumerate(inputs, start=1):
            if not source.exists():
                raise SystemExit(f"input BPMN does not exist: {source}")
            part_dir = workdir / f"part-{index:02d}-{source.stem}"
            part_dir.mkdir()

            entry: dict[str, object] = {
                "title": source.name,
                "source": str(source),
                "directory": part_dir.name,
                "original": None,
                "engines": {},
            }

            if source_has_di(source):
                original_bpmn = part_dir / "original.bpmn"
                shutil.copyfile(source, original_bpmn)
                original_svg = part_dir / "original.svg"
                run_command(image_command + [str(original_bpmn), str(original_svg)], f"render original {source}")
                entry["original"] = {
                    "bpmn": str(original_bpmn.relative_to(workdir)),
                    "svg": str(original_svg.relative_to(workdir)),
                    "metrics": collect_metrics(original_bpmn),
                    "error": None,
                    "na_reason": None,
                }

            for name, command in resolved_commands.items():
                engine_bpmn = part_dir / f"{name}.bpmn"
                shutil.copyfile(source, engine_bpmn)
                column: dict[str, object] = {"bpmn": None, "svg": None, "metrics": None, "error": None}
                error = run_engine_command(command + [str(engine_bpmn)], f"layout ({name}) {source}")
                if error is None:
                    engine_svg = part_dir / f"{name}.svg"
                    error = run_engine_command(
                        image_command + [str(engine_bpmn), str(engine_svg)], f"render ({name}) {source}"
                    )
                    if error is None:
                        column["bpmn"] = str(engine_bpmn.relative_to(workdir))
                        column["svg"] = str(engine_svg.relative_to(workdir))
                        column["metrics"] = collect_metrics(engine_bpmn)
                column["error"] = error
                entry["engines"][name] = column  # type: ignore[index]

            # The "original" column exists to be an independent third point
            # of comparison. If its committed DI is actually a copy of our
            # own engine's output for this same source, it is not
            # independent -- showing it as agreement would be corroboration
            # theater (#62). Compare geometry, not bytes: engines[name]["bpmn"]
            # was already re-serialized by moddle-xml, so formatting can
            # differ even when nothing about the geometry did.
            original = entry.get("original")
            ours = entry["engines"].get("ours")  # type: ignore[index]
            if original and ours and ours.get("bpmn"):
                original_xml = (workdir / original["bpmn"]).read_text(encoding="utf8")  # type: ignore[index]
                ours_xml = (workdir / ours["bpmn"]).read_text(encoding="utf8")
                seeded_reason = original_seeded_reason(original_xml, ours_xml)
                if seeded_reason:
                    original["na_reason"] = f"{seeded_reason} (#62)"  # type: ignore[index]

            entries.append(entry)

        metrics_doc = {
            "schema": "bpmn-layout-report/v2",
            "commit": resolve_commit_sha(),
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "engines": [
                {"name": name, "command": shlex.join(raw_engine_commands[name]), "version": engine_versions[name]}
                for name in raw_engine_commands
            ],
            "entries": entries,
        }
        (workdir / "metrics.json").write_text(json.dumps(metrics_doc, indent=2, sort_keys=True) + "\n", encoding="utf8")
        (workdir / "index.html").write_text(report_html(metrics_doc), encoding="utf8")
        return workdir / "index.html"
    finally:
        for path in cleanup_paths:
            path.unlink(missing_ok=True)


# #55: a public comparison that scores another engine on metrics derived
# from our own failure modes is not credible unless it is honest about what
# it is doing. Two tables, never one blended score:
#
# VALIDITY is spec-grounded and fair to any engine -- geometry any BPMN
# renderer should get right, no house style involved.
VALIDITY_METRIC_PATHS: list[tuple[str, tuple[str, ...]]] = [
    ("shape overlaps", ("layout", "shape_overlaps")),
    ("edge/shape intersections", ("layout", "edge_shape_intersections")),
    ("edge/container intersections", ("layout", "edge_container_intersections")),
    ("edge crossings", ("layout", "edge_crossings")),
    ("non-orthogonal segments", ("layout", "non_orthogonal_segments")),
    ("invalid edge attachments", ("layout", "invalid_edge_attachments")),
    ("degenerate waypoints", ("layout", "degenerate_waypoints")),
    ("node containment violations", ("layout", "node_containment_violations")),
    ("label containment violations", ("layout", "label_containment_violations")),
    ("missing named labels", ("layout", "named_label_coverage", "missing")),
]

# AESTHETICS is our own §8 routing-priority preferences, explicitly labelled
# as such -- an engine that makes different trade-offs (e.g. more bends to
# avoid ever cutting through a shape) is not thereby wrong.
AESTHETIC_METRIC_PATHS: list[tuple[str, tuple[str, ...]]] = [
    ("total bends", ("layout", "total_bends")),
    ("excess turns", ("layout", "excess_turns")),
    ("total Manhattan length", ("layout", "total_manhattan_length")),
    ("horizontal flow gap consistency (max-min)", ("layout", "horizontal_flow_gap", "consistency")),
    ("canvas area", ("layout", "canvas_area")),
]

# Descriptive counts: not a judgment either way, just context for the tables
# above. Implementation-specific conventions (route_lattice, grid deviation,
# detour ratio, node/label gap) are deliberately excluded from both headline
# tables -- they describe our own 50px-grid routing convention, which a
# different engine has no reason to share, so scoring another engine against
# them would not be a comparison, just a restatement of "it isn't us" (#55).
OTHER_METRIC_PATHS: list[tuple[str, tuple[str, ...]]] = [
    ("diagrams", ("layout", "diagrams")),
    ("shapes", ("layout", "shapes")),
    ("edges", ("layout", "edges")),
    ("labels", ("layout", "labels")),
    ("label overlaps", ("layout", "label_overlaps")),
    ("label/shape intersections", ("layout", "label_shape_intersections")),
    ("label/edge intersections", ("layout", "label_edge_intersections")),
    ("detour ratio average", ("layout", "detour_ratio", "avg")),
    ("detour ratio maximum", ("layout", "detour_ratio", "max")),
    ("collinear pass-through waypoints", ("layout", "collinear_waypoints")),
    ("non-50px route segments (our grid convention)", ("layout", "route_lattice", "non_multiple_segments")),
    ("grid center-x avg deviation (our grid convention)", ("layout", "grid_center_x_deviation_avg")),
    ("event label gap average", ("layout", "node_label_gap", "event", "avg")),
    ("gateway label gap average", ("layout", "node_label_gap", "gateway", "avg")),
    ("horizontal flow gap average", ("layout", "horizontal_flow_gap", "avg")),
    ("sequence flows", ("semantic", "sequence_flows")),
    ("message flows", ("semantic", "message_flows")),
    ("lanes", ("semantic", "lanes")),
    ("data references", ("semantic", "data_references")),
]

# Every label-collision metric reads as a vacuous 0 for an engine that emits
# no BPMNLabel elements at all -- you cannot overlap a label you did not
# draw. Rendered as n/a instead of 0 wherever one of these paths appears, in
# any table (#55's central honesty fix: suppressing vacuous zeros).
LABEL_DEPENDENT_METRIC_PATHS: set[tuple[str, ...]] = {
    ("layout", "label_overlaps"),
    ("layout", "label_shape_intersections"),
    ("layout", "label_edge_intersections"),
    ("layout", "label_containment_violations"),
}


def get_metric(doc: dict[str, object] | None, path: tuple[str, ...]) -> object:
    """Look up a dotted metric path in a metrics document, returning None
    (rather than raising) when the document is absent (an engine that
    errored) or does not have that path -- a column that could not be
    scored must read as missing, never crash the whole report (#53)."""
    current: object = doc
    for key in path:
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


EXCESS_TURNS_PATH: tuple[str, ...] = ("layout", "excess_turns")


def format_metric_cell(
    path: tuple[str, ...],
    metrics: dict[str, object] | None,
    error: str | None,
    na_reason: str | None = None,
) -> str:
    if na_reason is not None:
        # A whole-column exclusion (e.g. #62's self-seeded "original") wins
        # over any per-metric value -- the column was never meant to be
        # scored at all, so there is nothing for a per-metric reason to add.
        return f"n/a ({na_reason})"
    if error is not None:
        return "error"
    if path in LABEL_DEPENDENT_METRIC_PATHS and not get_metric(metrics, ("layout", "labels")):
        return "n/a (emits no labels)"
    value = get_metric(metrics, path)
    if value is None:
        return "n/a"
    if path == EXCESS_TURNS_PATH:
        # #56: an edge whose attach sides don't resolve to a boundary side
        # (attach_side returns None) cannot get a baseline bend count, so it
        # is excluded from `value` rather than silently read as 0 excess.
        # Surface that exclusion instead of letting a clean-looking total
        # imply full coverage.
        unscored = get_metric(metrics, ("layout", "excess_turns_unscored")) or 0
        if unscored:
            return f"{value} (+{unscored} unscored)"
    return str(value)


ReportColumn = tuple[str, dict[str, object] | None, str | None, str | None]


def metric_rows(paths: list[tuple[str, tuple[str, ...]]], columns: list[ReportColumn]) -> str:
    """Render one row per metric in `paths` across N named (name, metrics,
    error, na_reason) columns -- generalized from the original fixed
    (original, transformed) pair so a report can compare any number of
    engines (#53), and reused across the validity/aesthetics/other tables
    (#55)."""
    rows = []
    for label, path in paths:
        cells = "".join(
            f"<td>{html.escape(format_metric_cell(path, metrics, error, na_reason))}</td>"
            for _name, metrics, error, na_reason in columns
        )
        rows.append(f"<tr><th>{html.escape(label)}</th>{cells}</tr>")
    return "\n".join(rows)


def report_html(metrics_doc: dict[str, object]) -> str:
    entries = metrics_doc["entries"]  # type: ignore[index]
    engines = metrics_doc.get("engines", [])  # type: ignore[union-attr]
    engine_names = [engine["name"] for engine in engines]  # type: ignore[index]
    commit = html.escape(str(metrics_doc.get("commit", "unknown")))
    generated_at = html.escape(str(metrics_doc.get("generated_at", "unknown")))
    sections: list[str] = []
    for entry in entries:  # type: ignore[assignment]
        title = html.escape(entry["title"])
        columns: list[ReportColumn] = []
        figures: list[str] = []
        original = entry.get("original")
        if original:
            na_reason = original.get("na_reason")
            columns.append(("original", original["metrics"], original["error"], na_reason))
            caption = "original" if not na_reason else f"original ({html.escape(na_reason)})"
            figures.append(
                f'<figure><figcaption>{caption}</figcaption>'
                f'<img src="{html.escape(original["svg"])}" alt="original BPMN image for {title}"></figure>'
            )
        for name in engine_names:
            column = entry["engines"][name]  # type: ignore[index]
            columns.append((name, column["metrics"], column["error"], None))
            if column["svg"]:
                figures.append(
                    f'<figure><figcaption>{html.escape(name)}</figcaption>'
                    f'<img src="{html.escape(column["svg"])}" alt="{html.escape(name)} BPMN image for {title}"></figure>'
                )
            else:
                figures.append(
                    f'<figure><figcaption>{html.escape(name)}</figcaption>'
                    f'<p class="engine-error">{html.escape(column["error"] or "no output")}</p></figure>'
                )
        header_cells = "".join(f"<th>{html.escape(name)}</th>" for name, _metrics, _error, _na_reason in columns)
        details = "".join(
            f"<details><summary>{html.escape(name)} metrics JSON</summary>"
            f"<pre>{(html.escape('n/a (' + na_reason + ') -- not used for comparison; raw metrics below for reference:') + chr(10) + chr(10)) if na_reason else ''}"
            f"{html.escape(json.dumps(metrics, indent=2, sort_keys=True) if metrics is not None else (error or 'n/a'))}</pre></details>"
            for name, metrics, error, na_reason in columns
        )
        sections.append(
            f"""
<section class="part">
  <h2>{title}</h2>
  <p><strong>Source:</strong> {html.escape(entry['source'])}</p>
  <h3>Images</h3>
  <div class="images" style="grid-template-columns: repeat({max(len(figures), 1)}, minmax(0, 1fr));">
    {''.join(figures)}
  </div>
  <h3>Validity <span class="table-note">(spec-grounded, fair to any engine)</span></h3>
  <table><thead><tr><th>Metric</th>{header_cells}</tr></thead><tbody>
    {metric_rows(VALIDITY_METRIC_PATHS, columns)}
  </tbody></table>
  <h3>Aesthetics <span class="table-note">(our own §8 routing priorities -- see bias note above)</span></h3>
  <table><thead><tr><th>Metric</th>{header_cells}</tr></thead><tbody>
    {metric_rows(AESTHETIC_METRIC_PATHS, columns)}
  </tbody></table>
  <details>
    <summary>Other metrics (descriptive counts and our own grid-convention internals, excluded from comparison)</summary>
    <table><thead><tr><th>Metric</th>{header_cells}</tr></thead><tbody>
      {metric_rows(OTHER_METRIC_PATHS, columns)}
    </tbody></table>
  </details>
  {details}
</section>
"""
        )
    engine_meta = "".join(
        f"<li><strong>{html.escape(engine['name'])}</strong>: "  # type: ignore[index]
        f"<code>{html.escape(engine['command'])}</code> (version {html.escape(engine['version'])})</li>"  # type: ignore[index]
        for engine in engines
    )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>BPMN layout feedback report</title>
<style>
body {{ font-family: sans-serif; margin: 2rem; color: #1f2328; }}
.part {{ border-top: 1px solid #d0d7de; padding-top: 1.5rem; margin-top: 1.5rem; }}
.bias-note {{ background: #fff8c5; border: 1px solid #d4a72c; padding: 1rem; margin: 1rem 0; }}
.table-note {{ font-weight: normal; color: #57606a; font-size: 0.85em; }}
.images {{ display: grid; gap: 1rem; }}
figure {{ margin: 0; border: 1px solid #d0d7de; padding: .75rem; overflow: auto; }}
figcaption {{ font-weight: 600; margin-bottom: .5rem; }}
img {{ max-width: 100%; background: white; }}
.engine-error {{ color: #a40e26; font-family: monospace; white-space: pre-wrap; }}
table {{ border-collapse: collapse; margin: 1rem 0; }}
th, td {{ border: 1px solid #d0d7de; padding: .35rem .5rem; text-align: right; }}
th:first-child {{ text-align: left; }}
pre {{ overflow: auto; background: #f6f8fa; padding: 1rem; }}
</style>
</head>
<body>
<h1>BPMN layout feedback report</h1>
<p>This report is ephemeral and workspace-local. Metrics are also available in <a href="metrics.json">metrics.json</a>.</p>
<div class="bias-note">
  <strong>On comparing engines with these metrics:</strong> every metric here was developed
  against this engine's own failure modes, so a raw score is not a fair engine-vs-engine ranking
  on its own (#55). Each diagram below is scored in two separate tables instead of one number:
  <strong>Validity</strong> is spec-grounded and should hold for any correct BPMN renderer;
  <strong>Aesthetics</strong> encodes this project's own routing-priority preferences (§8) and is
  labelled as such -- an engine that trades more bends for never cutting through a shape is not
  thereby wrong. A metric an engine cannot meaningfully score (e.g. every label-collision metric,
  for an engine that emits no label DI at all) reads as <code>n/a</code>, never a vacuous
  <code>0</code>. Metrics describing only this engine's own 50px-grid routing convention are
  excluded from both tables as not comparable. No combined score or ranking is computed anywhere
  in this report.
</div>
<h2>Engines</h2>
<p>Measured at commit <code>{commit}</code>, generated {generated_at}. A reader who wants to check whether
a favourable trend coincided with a metric edit (rather than a layout edit) should diff this report's
commit against <code>tools/bpmn_feedback.py</code>'s history (#58).</p>
<ul>{engine_meta}</ul>
{''.join(sections)}
</body>
</html>
"""


def resolve_report_reference(reference: str, output_dir: str = ".bpmn-feedback/reports") -> Path:
    path = Path(reference)
    if path.exists():
        return path

    root = Path(output_dir)
    if reference == "latest":
        return latest_report(output_dir)

    exact = root / reference
    if exact.is_dir():
        return exact
    if (exact / "index.html").is_file():
        return exact / "index.html"

    matches = [
        report
        for report in root.glob("report-*/index.html")
        if report.parent.name == reference
        or report.parent.name.removeprefix("report-") == reference
        or report.parent.name.startswith(reference)
        or report.parent.name.removeprefix("report-").startswith(reference)
    ]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        names = ", ".join(report.parent.name for report in matches)
        raise SystemExit(f"ambiguous report reference {reference!r}; choose one of: {names}")
    return path


def print_host_view_command(report: Path) -> None:
    print(f"Host command to view report: xdg-open {shlex.quote(str(report.resolve()))}")
def collect_geometry(path: Path) -> tuple[dict[str, dict[str, float]], dict[str, list[tuple[float, float]]]]:
    """Bounds and edge waypoints keyed by bpmnElement id, across every plane
    in the file. Used to compare two laid-out versions of (structurally)
    the same diagram element-by-element."""
    root = parse_xml(path)
    shape_bounds: dict[str, dict[str, float]] = {}
    edge_points: dict[str, list[tuple[float, float]]] = {}
    for plane in root.iter(q("bpmndi", "BPMNPlane")):
        for shape in plane.findall(q("bpmndi", "BPMNShape")):
            bounds = bounds_from(shape)
            target = shape.get("bpmnElement")
            if bounds and target:
                shape_bounds[target] = bounds
        for edge in plane.findall(q("bpmndi", "BPMNEdge")):
            target = edge.get("bpmnElement")
            if not target:
                continue
            edge_points[target] = [
                (float(point.get("x", "0")), float(point.get("y", "0")))
                for point in edge.findall(q("di", "waypoint"))
            ]
    return shape_bounds, edge_points


def stability_report(base: Path, variant: Path) -> dict[str, object]:
    """Compare two already-laid-out BPMN files element-by-element and report
    how much of the geometry shared between them (same bpmnElement ids)
    moved -- the "does adding one unrelated element move everything else"
    check from `AGENTS.md` §6 determinism and stability."""
    base_shapes, base_edges = collect_geometry(base)
    variant_shapes, variant_edges = collect_geometry(variant)

    common_shapes = set(base_shapes) & set(variant_shapes)
    moved_details: list[dict[str, object]] = []
    for element_id in common_shapes:
        a, b = base_shapes[element_id], variant_shapes[element_id]
        dx, dy = b["x"] - a["x"], b["y"] - a["y"]
        delta = (dx**2 + dy**2) ** 0.5
        if delta > 0.5:
            moved_details.append({"element": element_id, "delta": round(delta, 2), "dx": round(dx, 2), "dy": round(dy, 2)})
    moved_details.sort(key=lambda detail: -detail["delta"])  # type: ignore[arg-type,return-value]
    deltas = [detail["delta"] for detail in moved_details]

    common_edges = set(base_edges) & set(variant_edges)
    changed_details = [
        {
            "element": element_id,
            "base_waypoints": len(base_edges[element_id]),
            "variant_waypoints": len(variant_edges[element_id]),
        }
        for element_id in common_edges
        if base_edges[element_id] != variant_edges[element_id]
    ]

    return {
        "schema": "bpmn-layout-stability/v1",
        "base": str(base),
        "variant": str(variant),
        "shapes": {
            "common": len(common_shapes),
            "moved": len(moved_details),
            "moved_ratio": round(len(moved_details) / len(common_shapes), 4) if common_shapes else 0,
            "max_delta": round(max(deltas), 2) if deltas else 0,
            "avg_delta": round(sum(deltas) / len(deltas), 2) if deltas else 0,
            "moved_details": moved_details,
        },
        "edges": {
            "common": len(common_edges),
            "changed": len(changed_details),
            "changed_ratio": round(len(changed_details) / len(common_edges), 4) if common_edges else 0,
            "changed_details": changed_details,
        },
    }


def stability(base_input: Path, variant_input: Path, layout_command: list[str]) -> dict[str, object]:
    scratch = Path(".bpmn-feedback") / "stability"
    scratch.mkdir(parents=True, exist_ok=True)
    base_target = scratch / f"base-{base_input.name}"
    variant_target = scratch / f"variant-{variant_input.name}"
    shutil.copyfile(base_input, base_target)
    shutil.copyfile(variant_input, variant_target)
    run_command(layout_command + [str(base_target)], f"layout {base_input}")
    run_command(layout_command + [str(variant_target)], f"layout {variant_input}")
    return stability_report(base_target, variant_target)


def validate_fixture_references(xml: str) -> list[str]:
    """Check a fixture's internal references before anything is laid out.

    The corpus is checked for element-type coverage, and its layout output is
    checked for geometry, but nothing has ever checked that a fixture is
    internally consistent BPMN. A dangling <outgoing> pointing at an element
    that did not exist shipped in data-artifacts.bpmn until it was noticed by
    hand, making bpmn-moddle report "unresolved reference" on every parse,
    because no gate looked. These are the cheap structural checks an editor
    would make, run against the files as committed.
    """
    root = ET.fromstring(xml)
    problems: list[str] = []

    ids = [element.get("id") for element in root.iter() if element.get("id")]
    known = set(ids)
    counts = Counter(ids)
    problems.extend(f"duplicate id '{name}'" for name in sorted(counts) if counts[name] > 1)

    for name in ("sequenceFlow", "messageFlow", "association"):
        for element in root.iter(q("bpmn", name)):
            for attribute in ("sourceRef", "targetRef"):
                ref = element.get(attribute)
                if ref and ref not in known:
                    problems.append(f"{element.get('id')}: {attribute} '{ref}' does not exist")

    for boundary in root.iter(q("bpmn", "boundaryEvent")):
        host = boundary.get("attachedToRef")
        if host and host not in known:
            problems.append(f"{boundary.get('id')}: attachedToRef '{host}' does not exist")

    claimed: dict[str, str] = {}
    for lane in root.iter(q("bpmn", "lane")):
        lane_id = lane.get("id", "")
        for ref in lane.findall(q("bpmn", "flowNodeRef")):
            member = (ref.text or "").strip()
            if not member:
                continue
            if member not in known:
                problems.append(f"lane {lane_id}: flowNodeRef '{member}' does not exist")
            elif member in claimed:
                problems.append(f"'{member}' is claimed by lane {claimed[member]} and lane {lane_id}")
            else:
                claimed[member] = lane_id

    flows = {
        flow.get("id", ""): (flow.get("sourceRef"), flow.get("targetRef"))
        for flow in root.iter(q("bpmn", "sequenceFlow"))
    }
    for element in root.iter():
        element_id = element.get("id")
        if not element_id or local_name(element.tag) not in FLOW_NODE_TYPES:
            continue
        # <incoming>/<outgoing> reference sequence flows only. Listing an
        # association or a stale id there is what bpmn-moddle reports as an
        # unresolved reference.
        for attribute, expected in (
            ("incoming", {fid for fid, (_, target) in flows.items() if target == element_id}),
            ("outgoing", {fid for fid, (source, _) in flows.items() if source == element_id}),
        ):
            declared = {
                child.text.strip()
                for child in element
                if local_name(child.tag) == attribute and child.text and child.text.strip()
            }
            if declared != expected:
                problems.append(
                    f"{element_id}: <{attribute}> lists {sorted(declared)} "
                    f"but the sequence flows say {sorted(expected)}"
                )

    for di in root.iter():
        target = di.get("bpmnElement")
        if target and local_name(di.tag) in {"BPMNShape", "BPMNEdge"} and target not in known:
            problems.append(f"DI {di.get('id')}: bpmnElement '{target}' does not exist")

    return problems


def assert_fixture_references(fixtures: dict[str, str], label: str) -> None:
    """Fail loudly when any fixture in the set is not internally consistent."""
    failures = [
        f"{filename}: {problem}"
        for filename, xml in sorted(fixtures.items())
        for problem in validate_fixture_references(xml)
    ]
    if failures:
        raise SystemExit(
            f"{label} fixtures have broken references:\n" + "\n".join(f"  {failure}" for failure in failures)
        )


def selftest(layout_command: list[str] | None = None, structure_only: bool = False) -> None:
    first = persisted_fixtures()
    second = persisted_fixtures()
    if first != second:
        raise SystemExit("persisted fixture set changed while being read")
    assert_fixture_references(first, "persisted")
    # A checker that only ever sees clean input can rot into a no-op without
    # anyone noticing -- which is how selftest itself once printed OK while
    # verifying nothing (#43). Prove the reference check still bites.
    canary = first[sorted(first)[0]].replace(
        "</bpmn:process>",
        '<bpmn:sequenceFlow id="Selftest_Canary" sourceRef="Selftest_Missing" targetRef="Selftest_Missing" />'
        "</bpmn:process>",
        1,
    )
    if not validate_fixture_references(canary):
        raise SystemExit("reference validation no longer detects a dangling sourceRef")
    scratch = Path(".bpmn-feedback") / "selftest"
    scratch.mkdir(parents=True, exist_ok=True)
    targets: dict[str, Path] = {}
    for filename, xml in first.items():
        target = scratch / filename
        target.write_text(xml, encoding="utf8")
        targets[filename] = target
    engine_ran = False
    if layout_command:
        engine_ran = layout_fixtures(list(targets.values()), layout_command, structure_only, "selftest")
    aggregate: dict[str, int] = {}
    for filename, target in targets.items():
        metrics = collect_metrics(target)
        if metrics["layout"]["diagrams"] < 1:  # type: ignore[index]
            raise SystemExit(f"fixture lacks BPMN DI diagram: {filename}")
        for name, count in metrics["semantic"]["element_counts"].items():  # type: ignore[index]
            aggregate[name] = aggregate.get(name, 0) + count
    required = [
        "startEvent",
        "endEvent",
        "intermediateCatchEvent",
        "intermediateThrowEvent",
        "task",
        "userTask",
        "serviceTask",
        "sendTask",
        "manualTask",
        "scriptTask",
        "exclusiveGateway",
        "inclusiveGateway",
        "parallelGateway",
        "subProcess",
        "boundaryEvent",
        "lane",
        "messageFlow",
        "association",
        "dataInputAssociation",
        "dataOutputAssociation",
        "ioSpecification",
        "dataInput",
        "dataOutput",
        "textAnnotation",
        "group",
        "dataObjectReference",
        "dataStoreReference",
        "messageEventDefinition",
        "timerEventDefinition",
    ]
    missing = [name for name in required if aggregate.get(name, 0) == 0]
    if missing:
        raise SystemExit(f"persisted fixtures are missing required element types: {', '.join(missing)}")
    collaboration_xml = first["collaboration-lanes-messages.bpmn"]
    if "Participant_Customer" not in collaboration_xml or "Participant_Supplier" not in collaboration_xml:
        raise SystemExit("collaboration fixture lost original pool participants")

    # A curated fixture's committed DI is supposed to be an independent
    # reference -- both for human visual review and as the report's
    # "original" column (#62). One seeded directly from this engine's own
    # output is neither: print it (never fail on it -- the fixture is still
    # valid BPMN, and the fix is a judgment call about the corpus, not a
    # build defect) so it stays visible rather than silently drifting back
    # in the next time someone adds a fixture the same way.
    if engine_ran:
        for filename, xml in first.items():
            seeded_reason = original_seeded_reason(xml, targets[filename].read_text(encoding="utf8"))
            if seeded_reason:
                print(f"selftest notice: {filename} {seeded_reason} (#62)")

    # Referential integrity (#57): no dangling refs, no duplicate ids, no
    # <incoming>/<outgoing> mismatch, across every fixture family --
    # persisted, regression, and the generated corpus when it exists. Pure
    # XML parsing, no layout engine, so it always runs regardless of
    # --structure-only.
    integrity_problems: list[str] = []
    for family, fixtures in (
        ("", first),
        ("regression/", regression_fixtures()),
        ("generated/", generated_fixtures()),
    ):
        for filename, xml in fixtures.items():
            integrity_problems.extend(
                f"{family}{filename}: {problem}" for problem in referential_integrity_problems(ET.fromstring(xml))
            )
    if integrity_problems:
        raise SystemExit("referential integrity problems:\n" + "\n".join(f"  {p}" for p in integrity_problems))

    if engine_ran:
        print(
            f"selftest OK: {len(first)} persisted fixtures cover {len(required)} required element types "
            "(with fresh layout-engine output)",
        )
        return
    # structure_only is the only way engine_ran can be False here without
    # layout_fixtures having already raised (#43) -- an explicit, printed
    # degradation rather than a silent one dressed up as OK.
    print(
        f"selftest SKIPPED the layout-engine check: {len(first)} persisted fixtures cover "
        f"{len(required)} required element types, but only structure was validated "
        "(--structure-only was passed)",
    )


def regression_fixtures() -> dict[str, str]:
    fixture_dir = Path("fixtures") / "regression"
    fixtures = sorted(fixture_dir.glob("*.bpmn"))
    if not fixtures:
        raise SystemExit(f"no regression fixtures found under {fixture_dir}")
    return {fixture.name: fixture.read_text(encoding="utf8") for fixture in fixtures}


def generated_fixtures() -> dict[str, str]:
    """The parametric benchmark corpus under fixtures/generated/ (#57) --
    unlike regression_fixtures, an empty or absent directory is not an
    error: the corpus is optional until tools/corpus-generator has been run
    at least once, and selftest must still pass on a checkout that predates
    it."""
    fixture_dir = Path("fixtures") / "generated"
    if not fixture_dir.is_dir():
        return {}
    return {fixture.name: fixture.read_text(encoding="utf8") for fixture in sorted(fixture_dir.glob("*.bpmn"))}


def shape_bounds_by_element(root: ET.Element) -> dict[str, dict[str, float]]:
    bounds: dict[str, dict[str, float]] = {}
    for plane in root.iter(q("bpmndi", "BPMNPlane")):
        for shape in plane.findall(q("bpmndi", "BPMNShape")):
            element_id = shape.get("bpmnElement")
            shape_bounds = bounds_from(shape)
            if element_id and shape_bounds is not None:
                bounds[element_id] = shape_bounds
    return bounds


def check_boundary_events_distinct(root: ET.Element) -> list[str]:
    """Pins #7: two boundary events attached to the same host must never be
    placed at byte-identical coordinates."""
    bounds = shape_bounds_by_element(root)
    coords: dict[tuple[float, float], list[str]] = {}
    for element in root.iter(q("bpmn", "boundaryEvent")):
        element_id = element.get("id", "")
        element_bounds = bounds.get(element_id)
        if element_bounds is None:
            continue
        key = (element_bounds["x"], element_bounds["y"])
        coords.setdefault(key, []).append(element_id)
    return [
        f"boundary events share identical coordinates {key}: {', '.join(ids)}"
        for key, ids in coords.items()
        if len(ids) > 1
    ]


def check_lane_bands_tile(root: ET.Element) -> list[str]:
    """Pins #2: a multi-lane process with no collaboration must still emit
    lanes that stack or tile into a single band, not diagonal neighbours."""
    bounds = shape_bounds_by_element(root)
    lanes = [
        (lane.get("id", ""), bounds[lane.get("id", "")])
        for lane in root.iter(q("bpmn", "lane"))
        if lane.get("id") in bounds
    ]
    if len(lanes) < 2:
        return [f"expected at least 2 lanes with DI, found {len(lanes)}"]
    problems: list[str] = []
    for i, (id_a, a) in enumerate(lanes):
        for id_b, b in lanes[i + 1 :]:
            if box_overlap(a, b) > 0:
                problems.append(f"lanes {id_a} and {id_b} overlap")
                continue
            same_column = abs(a["x"] - b["x"]) < 0.5 and abs(a["width"] - b["width"]) < 0.5
            same_row = abs(a["y"] - b["y"]) < 0.5 and abs(a["height"] - b["height"]) < 0.5
            if not (same_column or same_row):
                problems.append(f"lanes {id_a} and {id_b} are diagonal neighbours instead of a single stack")
            elif same_column:
                gap = (b["y"] - (a["y"] + a["height"])) if b["y"] >= a["y"] else (a["y"] - (b["y"] + b["height"]))
                if abs(gap) > 0.5:
                    problems.append(f"lanes {id_a} and {id_b} are not contiguous: gap={gap}")
    return problems


def check_subprocess_internal_edges_stay_inside(root: ET.Element) -> list[str]:
    """Pins #26/#27: a sequence flow routed entirely between two children of
    the same expanded subprocess must stay inside that subprocess's bounds."""
    parents = subprocess_parents(root)
    shape_bounds = shape_bounds_by_element(root)
    flow_endpoints = {
        flow.get("id", ""): (flow.get("sourceRef"), flow.get("targetRef"))
        for flow in root.iter(q("bpmn", "sequenceFlow"))
    }
    problems: list[str] = []
    for plane in root.iter(q("bpmndi", "BPMNPlane")):
        for edge in plane.findall(q("bpmndi", "BPMNEdge")):
            flow_id = edge.get("bpmnElement", "")
            source_id, target_id = flow_endpoints.get(flow_id, (None, None))
            if not source_id or not target_id:
                continue
            container_id = parents.get(source_id)
            if container_id is None or container_id != parents.get(target_id):
                continue
            container_bounds = shape_bounds.get(container_id)
            if container_bounds is None:
                continue
            points = [
                (float(point.get("x", "0")), float(point.get("y", "0")))
                for point in edge.findall(q("di", "waypoint"))
            ]
            for point in points:
                if not point_within(point, container_bounds):
                    problems.append(f"{flow_id} leaves its container {container_id} at {point}")
    return problems


def check_gateway_bypass_avoids_sibling(root: ET.Element) -> list[str]:
    """Pins #41: a sequence flow that bypasses a same-track sibling placed
    directly between a gateway and its target (skipping over a review/detour
    branch that rejoins on the same row) must route around that sibling, not
    straight through it."""
    shape_bounds = shape_bounds_by_element(root)
    flow_endpoints = {
        flow.get("id", ""): (flow.get("sourceRef"), flow.get("targetRef"))
        for flow in root.iter(q("bpmn", "sequenceFlow"))
    }
    problems: list[str] = []
    for plane in root.iter(q("bpmndi", "BPMNPlane")):
        for edge in plane.findall(q("bpmndi", "BPMNEdge")):
            flow_id = edge.get("bpmnElement", "")
            source_id, target_id = flow_endpoints.get(flow_id, (None, None))
            if not source_id or not target_id:
                continue
            endpoints = {source_id, target_id}
            points = [
                (float(point.get("x", "0")), float(point.get("y", "0")))
                for point in edge.findall(q("di", "waypoint"))
            ]
            for element_id, bounds in shape_bounds.items():
                if element_id in endpoints:
                    continue
                for a, b in zip(points, points[1:]):
                    if segment_intersects_box(a, b, bounds):
                        problems.append(f"{flow_id} intersects sibling shape {element_id}")
    return problems


def check_no_degenerate_waypoints(root: ET.Element) -> list[str]:
    """Pins #46: no emitted edge may have two consecutive waypoints at (or
    within rounding of) the same point. A repeated point is a zero-length
    segment -- it contributes no geometry, inflates total_bends for free, and
    passes the orthogonal check incidentally rather than by being a real
    axis-aligned segment."""
    problems: list[str] = []
    for plane in root.iter(q("bpmndi", "BPMNPlane")):
        for edge in plane.findall(q("bpmndi", "BPMNEdge")):
            points = [
                (float(point.get("x", "0")), float(point.get("y", "0")))
                for point in edge.findall(q("di", "waypoint"))
            ]
            for a, b in zip(points, points[1:]):
                if abs(a[0] - b[0]) < 0.5 and abs(a[1] - b[1]) < 0.5:
                    problems.append(f"{edge.get('bpmnElement')} has a duplicated waypoint at {a}")
    return problems


def check_gateway_loop_bypasses_sibling_without_degenerate_waypoints(root: ET.Element) -> list[str]:
    """Pins #41 and #46 together: a gateway's forward branch *and* its
    loop-back both route past a same-track sibling sitting directly between
    them, and neither route may ship a duplicated waypoint while doing so.
    Filed as one fixture because both defects were reached through the same
    fallback/reassert code path and were only independently observable, not
    independently caused."""
    return check_gateway_bypass_avoids_sibling(root) + check_no_degenerate_waypoints(root)


def check_gateway_straight_continuation_is_direct(root: ET.Element) -> list[str]:
    """Pins #59: a gateway's outgoing flow to a same-track target with a
    clear corridor between them must stay a direct 2-point route, whatever
    the gateway's *other* branches do. The "Reassert only gateway channel
    routes" pass used to overwrite this flow unconditionally whenever the
    gateway had any other branch to a different track, forcing a 4+ point
    channel detour around nothing -- the mere existence of an unrelated
    branch should never affect a route that doesn't touch it."""
    flow_id = "Flow_Continue_Next"
    for plane in root.iter(q("bpmndi", "BPMNPlane")):
        for edge in plane.findall(q("bpmndi", "BPMNEdge")):
            if edge.get("bpmnElement") != flow_id:
                continue
            points = [
                (float(point.get("x", "0")), float(point.get("y", "0")))
                for point in edge.findall(q("di", "waypoint"))
            ]
            if len(points) != 2:
                return [f"{flow_id} expected a direct 2-point route, got {len(points)} points: {points}"]
            (x0, y0), (x1, y1) = points
            if abs(y0 - y1) > 0.5:
                return [f"{flow_id} expected a horizontal straight route, got {points}"]
            return []
    return [f"{flow_id} has no BPMNEdge in the laid-out diagram"]


REGRESSION_CHECKS: dict[str, Callable[[ET.Element], list[str]]] = {
    "boundary-events-three-on-one-host.bpmn": check_boundary_events_distinct,
    "lanes-without-collaboration.bpmn": check_lane_bands_tile,
    "subprocess-internal-branch.bpmn": check_subprocess_internal_edges_stay_inside,
    "gateway-same-track-bypass.bpmn": check_gateway_bypass_avoids_sibling,
    "gateway-bidirectional-bypass.bpmn": check_gateway_loop_bypasses_sibling_without_degenerate_waypoints,
    "gateway-straight-continuation.bpmn": check_gateway_straight_continuation_is_direct,
}


def _metrics_for_xml(xml: str) -> dict[str, object]:
    """Run collect_metrics against an in-memory BPMN+DI string via a scratch
    temp file. Backing tool for metric_selftests: each check builds its own
    minimal, hand-verified DI rather than depending on any layout engine's
    output (#56 item 4) -- every metric was previously validated only by
    agreeing with the engine it was written against, which is circular."""
    with tempfile.NamedTemporaryFile("w", suffix=".bpmn", delete=False, encoding="utf8") as handle:
        handle.write(xml)
        temp_path = Path(handle.name)
    try:
        return collect_metrics(temp_path)
    finally:
        temp_path.unlink(missing_ok=True)


_METRIC_TEST_XML_HEADER = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<bpmn:definitions xmlns:bpmn="{bpmn}" xmlns:bpmndi="{bpmndi}" xmlns:dc="{dc}" xmlns:di="{di}" '
    'id="Definitions_MetricTest" targetNamespace="https://example.com/metric-test">\n'
).format(**NS)


def _wrap_metric_test(process_body: str, diagram_body: str) -> str:
    return (
        f"{_METRIC_TEST_XML_HEADER}"
        f'  <bpmn:process id="Process_MetricTest" isExecutable="false">\n{process_body}  </bpmn:process>\n'
        '  <bpmndi:BPMNDiagram id="Diagram_MetricTest">\n'
        '    <bpmndi:BPMNPlane id="Plane_MetricTest" bpmnElement="Process_MetricTest">\n'
        f"{diagram_body}    </bpmndi:BPMNPlane>\n"
        "  </bpmndi:BPMNDiagram>\n"
        "</bpmn:definitions>\n"
    )


def metric_selftests() -> None:
    """Pin each audited metric to a value a human verified against
    hand-built DI, independent of any layout engine (#56 item 4)."""
    failures: list[str] = []
    checks = 0

    def expect(name: str, actual: object, expected: object) -> None:
        nonlocal checks
        checks += 1
        if actual != expected:
            failures.append(f"{name}: expected {expected!r}, got {actual!r}")

    # shape_overlaps: two tasks whose bounds overlap by a known amount.
    layout = _metrics_for_xml(
        _wrap_metric_test(
            '    <bpmn:task id="A" name="A" />\n    <bpmn:task id="B" name="B" />\n',
            '      <bpmndi:BPMNShape id="A_di" bpmnElement="A"><dc:Bounds x="0" y="0" width="100" height="80" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="B_di" bpmnElement="B"><dc:Bounds x="50" y="0" width="100" height="80" /></bpmndi:BPMNShape>\n',
        )
    )["layout"]
    expect("shape_overlaps (two overlapping tasks)", layout["shape_overlaps"], 1)

    # edge_shape_intersections: a flow between A and C drawn straight through
    # B's bounds, where B is not one of the flow's own endpoints.
    layout = _metrics_for_xml(
        _wrap_metric_test(
            '    <bpmn:task id="A" name="A" />\n    <bpmn:task id="B" name="B" />\n    <bpmn:task id="C" name="C" />\n'
            '    <bpmn:sequenceFlow id="F" sourceRef="A" targetRef="C" />\n',
            '      <bpmndi:BPMNShape id="A_di" bpmnElement="A"><dc:Bounds x="0" y="0" width="100" height="80" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="B_di" bpmnElement="B"><dc:Bounds x="150" y="0" width="100" height="80" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="C_di" bpmnElement="C"><dc:Bounds x="300" y="0" width="100" height="80" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNEdge id="F_di" bpmnElement="F">\n'
            '        <di:waypoint x="100" y="40" />\n        <di:waypoint x="400" y="40" />\n'
            "      </bpmndi:BPMNEdge>\n",
        )
    )["layout"]
    expect("edge_shape_intersections (flow drawn through an uninvolved task)", layout["edge_shape_intersections"], 1)

    # edge_crossings: an unrelated horizontal and vertical flow crossing in
    # the interior of both segments, far from any node -- not the "routes
    # converge at a shared node" geometry #48 exempts.
    layout = _metrics_for_xml(
        _wrap_metric_test(
            '    <bpmn:task id="A" name="A" />\n    <bpmn:task id="B" name="B" />\n'
            '    <bpmn:task id="C" name="C" />\n    <bpmn:task id="D" name="D" />\n'
            '    <bpmn:sequenceFlow id="Horizontal" sourceRef="A" targetRef="B" />\n'
            '    <bpmn:sequenceFlow id="Vertical" sourceRef="C" targetRef="D" />\n',
            '      <bpmndi:BPMNShape id="A_di" bpmnElement="A"><dc:Bounds x="-50" y="30" width="20" height="20" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="B_di" bpmnElement="B"><dc:Bounds x="130" y="30" width="20" height="20" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="C_di" bpmnElement="C"><dc:Bounds x="30" y="-50" width="20" height="20" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="D_di" bpmnElement="D"><dc:Bounds x="30" y="130" width="20" height="20" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNEdge id="Horizontal_di" bpmnElement="Horizontal">\n'
            '        <di:waypoint x="0" y="50" />\n        <di:waypoint x="120" y="50" />\n'
            "      </bpmndi:BPMNEdge>\n"
            '      <bpmndi:BPMNEdge id="Vertical_di" bpmnElement="Vertical">\n'
            '        <di:waypoint x="40" y="0" />\n        <di:waypoint x="40" y="120" />\n'
            "      </bpmndi:BPMNEdge>\n",
        )
    )["layout"]
    expect("edge_crossings (two unrelated flows crossing mid-route)", layout["edge_crossings"], 1)

    # total_bends / collinear_waypoints: a real bend at (100,0), then a
    # collinear pass-through waypoint at (100,100) that does not turn --
    # confirmed live in this engine's own output during the #56 audit.
    layout = _metrics_for_xml(
        _wrap_metric_test(
            '    <bpmn:task id="A" name="A" />\n    <bpmn:task id="B" name="B" />\n'
            '    <bpmn:sequenceFlow id="F" sourceRef="A" targetRef="B" />\n',
            '      <bpmndi:BPMNShape id="A_di" bpmnElement="A"><dc:Bounds x="-100" y="-40" width="100" height="80" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="B_di" bpmnElement="B"><dc:Bounds x="100" y="150" width="100" height="80" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNEdge id="F_di" bpmnElement="F">\n'
            '        <di:waypoint x="0" y="0" />\n        <di:waypoint x="100" y="0" />\n'
            '        <di:waypoint x="100" y="100" />\n        <di:waypoint x="100" y="150" />\n'
            "      </bpmndi:BPMNEdge>\n",
        )
    )["layout"]
    expect("total_bends (one real bend, one collinear pass-through)", layout["total_bends"], 1)
    expect("collinear_waypoints (pass-through point excluded from total_bends)", layout["collinear_waypoints"], 1)

    # degenerate_waypoints: a duplicated consecutive point contributes to
    # neither total_bends nor collinear_waypoints (#46, reconfirmed by #56).
    layout = _metrics_for_xml(
        _wrap_metric_test(
            '    <bpmn:task id="A" name="A" />\n    <bpmn:task id="B" name="B" />\n'
            '    <bpmn:sequenceFlow id="F" sourceRef="A" targetRef="B" />\n',
            '      <bpmndi:BPMNShape id="A_di" bpmnElement="A"><dc:Bounds x="-100" y="-40" width="100" height="80" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="B_di" bpmnElement="B"><dc:Bounds x="100" y="-40" width="100" height="80" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNEdge id="F_di" bpmnElement="F">\n'
            '        <di:waypoint x="0" y="0" />\n        <di:waypoint x="50" y="0" />\n'
            '        <di:waypoint x="50" y="0" />\n        <di:waypoint x="100" y="0" />\n'
            "      </bpmndi:BPMNEdge>\n",
        )
    )["layout"]
    expect("degenerate_waypoints (duplicated consecutive point)", layout["degenerate_waypoints"], 1)
    expect("total_bends (duplicated point is not a bend)", layout["total_bends"], 0)
    expect("collinear_waypoints (duplicated point is not collinear either)", layout["collinear_waypoints"], 0)

    # excess_turns: two ports facing each other, aligned so a straight route
    # is geometrically possible (baseline 0 bends), but the drawn route
    # takes 4 unnecessary bends -- min_bend_count's baseline must still
    # reflect 0 so every one of the 4 is reported as excess.
    layout = _metrics_for_xml(
        _wrap_metric_test(
            '    <bpmn:task id="A" name="A" />\n    <bpmn:task id="B" name="B" />\n'
            '    <bpmn:sequenceFlow id="F" sourceRef="A" targetRef="B" />\n',
            '      <bpmndi:BPMNShape id="A_di" bpmnElement="A"><dc:Bounds x="0" y="0" width="100" height="80" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="B_di" bpmnElement="B"><dc:Bounds x="300" y="0" width="100" height="80" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNEdge id="F_di" bpmnElement="F">\n'
            '        <di:waypoint x="100" y="40" />\n        <di:waypoint x="150" y="40" />\n'
            '        <di:waypoint x="150" y="80" />\n        <di:waypoint x="250" y="80" />\n'
            '        <di:waypoint x="250" y="40" />\n        <di:waypoint x="300" y="40" />\n'
            "      </bpmndi:BPMNEdge>\n",
        )
    )["layout"]
    expect("excess_turns (4 unnecessary bends where a straight route fit)", layout["excess_turns"], 4)
    expect("excess_turns_unscored (both attach sides resolve cleanly)", layout["excess_turns_unscored"], 0)

    # label_overlaps: two overlapping label boxes on unrelated elements.
    layout = _metrics_for_xml(
        _wrap_metric_test(
            '    <bpmn:task id="A" name="A" />\n    <bpmn:task id="B" name="B" />\n',
            '      <bpmndi:BPMNShape id="A_di" bpmnElement="A">\n'
            '        <dc:Bounds x="0" y="0" width="100" height="80" />\n'
            '        <bpmndi:BPMNLabel><dc:Bounds x="200" y="0" width="80" height="20" /></bpmndi:BPMNLabel>\n'
            "      </bpmndi:BPMNShape>\n"
            '      <bpmndi:BPMNShape id="B_di" bpmnElement="B">\n'
            '        <dc:Bounds x="300" y="100" width="100" height="80" />\n'
            '        <bpmndi:BPMNLabel><dc:Bounds x="240" y="10" width="80" height="20" /></bpmndi:BPMNLabel>\n'
            "      </bpmndi:BPMNShape>\n",
        )
    )["layout"]
    expect("label_overlaps (two overlapping label boxes)", layout["label_overlaps"], 1)

    # node_containment_violations: a subprocess child shape that overflows
    # its parent's bounds.
    layout = _metrics_for_xml(
        _wrap_metric_test(
            '    <bpmn:subProcess id="Sub" name="Sub">\n      <bpmn:task id="Inner" name="Inner" />\n    </bpmn:subProcess>\n',
            '      <bpmndi:BPMNShape id="Sub_di" bpmnElement="Sub"><dc:Bounds x="0" y="0" width="200" height="200" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="Inner_di" bpmnElement="Inner"><dc:Bounds x="150" y="150" width="100" height="100" /></bpmndi:BPMNShape>\n',
        )
    )["layout"]
    expect("node_containment_violations (subprocess child overflows its bounds)", layout["node_containment_violations"], 1)

    # edge_container_intersections (#64): a depth-2 nested subprocess. An
    # edge wholly inside the *inner* subprocess must not be reported against
    # the *outer* one just because subprocess_parents only ever recorded the
    # immediate parent -- the inner container sits entirely inside the outer
    # one, so the edge trivially satisfies the outer container's own bounds
    # check too.
    layout = _metrics_for_xml(
        _wrap_metric_test(
            '    <bpmn:subProcess id="Outer" name="Outer">\n'
            '      <bpmn:subProcess id="Inner" name="Inner">\n'
            '        <bpmn:task id="A" name="A" />\n        <bpmn:task id="B" name="B" />\n'
            '        <bpmn:sequenceFlow id="F" sourceRef="A" targetRef="B" />\n'
            "      </bpmn:subProcess>\n"
            "    </bpmn:subProcess>\n",
            '      <bpmndi:BPMNShape id="Outer_di" bpmnElement="Outer"><dc:Bounds x="0" y="0" width="400" height="300" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="Inner_di" bpmnElement="Inner"><dc:Bounds x="50" y="50" width="300" height="150" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="A_di" bpmnElement="A"><dc:Bounds x="80" y="80" width="100" height="80" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="B_di" bpmnElement="B"><dc:Bounds x="220" y="80" width="100" height="80" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNEdge id="F_di" bpmnElement="F">\n'
            '        <di:waypoint x="180" y="120" />\n        <di:waypoint x="220" y="120" />\n'
            "      </bpmndi:BPMNEdge>\n",
        )
    )["layout"]
    expect(
        "edge_container_intersections (depth-2 nesting: inner edge correctly inside both containers)",
        layout["edge_container_intersections"],
        0,
    )

    # edge_container_intersections (#64): three stacked lanes, a flow from
    # lane 1 to lane 3. Lane 2 sits strictly between them and the route never
    # strays outside the corridor spanning lanes 1-3 -- monotonic traversal
    # to its own two endpoints, not an excursion into lane 2's territory.
    layout = _metrics_for_xml(
        _wrap_metric_test(
            '    <bpmn:laneSet id="LaneSet">\n'
            '      <bpmn:lane id="Lane1" name="Lane1"><bpmn:flowNodeRef>A</bpmn:flowNodeRef></bpmn:lane>\n'
            '      <bpmn:lane id="Lane2" name="Lane2" />\n'
            '      <bpmn:lane id="Lane3" name="Lane3"><bpmn:flowNodeRef>C</bpmn:flowNodeRef></bpmn:lane>\n'
            "    </bpmn:laneSet>\n"
            '    <bpmn:task id="A" name="A" />\n    <bpmn:task id="C" name="C" />\n'
            '    <bpmn:sequenceFlow id="F" sourceRef="A" targetRef="C" />\n',
            '      <bpmndi:BPMNShape id="Lane1_di" bpmnElement="Lane1"><dc:Bounds x="0" y="0" width="400" height="100" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="Lane2_di" bpmnElement="Lane2"><dc:Bounds x="0" y="100" width="400" height="100" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="Lane3_di" bpmnElement="Lane3"><dc:Bounds x="0" y="200" width="400" height="100" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="A_di" bpmnElement="A"><dc:Bounds x="20" y="10" width="100" height="80" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="C_di" bpmnElement="C"><dc:Bounds x="20" y="210" width="100" height="80" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNEdge id="F_di" bpmnElement="F">\n'
            '        <di:waypoint x="70" y="90" />\n        <di:waypoint x="70" y="210" />\n'
            "      </bpmndi:BPMNEdge>\n",
        )
    )["layout"]
    expect(
        "edge_container_intersections (flow spans lane 1 to lane 3, monotonic through lane 2)",
        layout["edge_container_intersections"],
        0,
    )

    # Same three lanes, but the route from lane 1 to lane 3 detours below
    # lane 3's own bottom edge before coming back -- a real excursion, not
    # monotonic traversal, and must still be caught (#64's own caution: this
    # exemption must not swallow #11's real case).
    excursion_layout = _metrics_for_xml(
        _wrap_metric_test(
            '    <bpmn:laneSet id="LaneSet">\n'
            '      <bpmn:lane id="Lane1" name="Lane1"><bpmn:flowNodeRef>A</bpmn:flowNodeRef></bpmn:lane>\n'
            '      <bpmn:lane id="Lane2" name="Lane2" />\n'
            '      <bpmn:lane id="Lane3" name="Lane3"><bpmn:flowNodeRef>C</bpmn:flowNodeRef></bpmn:lane>\n'
            "    </bpmn:laneSet>\n"
            '    <bpmn:task id="A" name="A" />\n    <bpmn:task id="C" name="C" />\n'
            '    <bpmn:sequenceFlow id="F" sourceRef="A" targetRef="C" />\n',
            '      <bpmndi:BPMNShape id="Lane1_di" bpmnElement="Lane1"><dc:Bounds x="0" y="0" width="400" height="100" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="Lane2_di" bpmnElement="Lane2"><dc:Bounds x="0" y="100" width="400" height="100" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="Lane3_di" bpmnElement="Lane3"><dc:Bounds x="0" y="200" width="400" height="100" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="A_di" bpmnElement="A"><dc:Bounds x="20" y="10" width="100" height="80" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNShape id="C_di" bpmnElement="C"><dc:Bounds x="20" y="210" width="100" height="80" /></bpmndi:BPMNShape>\n'
            '      <bpmndi:BPMNEdge id="F_di" bpmnElement="F">\n'
            '        <di:waypoint x="70" y="90" />\n        <di:waypoint x="70" y="350" />\n'
            '        <di:waypoint x="150" y="350" />\n        <di:waypoint x="150" y="210" />\n'
            "      </bpmndi:BPMNEdge>\n",
        )
    )["layout"]
    expect(
        "edge_container_intersections (a real excursion below lane 3 must still be caught)",
        excursion_layout["edge_container_intersections"] > 0,
        True,
    )

    # named_label_coverage.missing: a named gateway with no BPMNLabel at all
    # -- a real, countable finding, not vacuous, even for an engine that
    # emits zero labels (#54, #55): every named element without label DI is
    # missing, whatever the reason.
    layout = _metrics_for_xml(
        _wrap_metric_test(
            '    <bpmn:exclusiveGateway id="G" name="Decide?" />\n',
            '      <bpmndi:BPMNShape id="G_di" bpmnElement="G"><dc:Bounds x="0" y="0" width="50" height="50" /></bpmndi:BPMNShape>\n',
        )
    )["layout"]
    expect("named_label_coverage.missing (named gateway with no label DI)", layout["named_label_coverage"]["missing"], 1)

    # format_metric_cell: the report-level n/a treatment (#55) is itself
    # pinned here, independent of any fixture -- a label-collision metric
    # reads as n/a when the column emits no labels, but named_label_coverage
    # is never treated this way, and a genuine error always wins.
    no_labels = {"layout": {"labels": 0, "label_overlaps": 0, "named_label_coverage": {"missing": 3}}}
    has_labels = {"layout": {"labels": 2, "label_overlaps": 1, "named_label_coverage": {"missing": 0}}}
    expect(
        "format_metric_cell (label_overlaps, no labels emitted)",
        format_metric_cell(("layout", "label_overlaps"), no_labels, None),
        "n/a (emits no labels)",
    )
    expect(
        "format_metric_cell (label_overlaps, labels emitted)",
        format_metric_cell(("layout", "label_overlaps"), has_labels, None),
        "1",
    )
    expect(
        "format_metric_cell (named_label_coverage.missing is never label-dependent n/a)",
        format_metric_cell(("layout", "named_label_coverage", "missing"), no_labels, None),
        "3",
    )
    expect(
        "format_metric_cell (an engine error always wins over a value)",
        format_metric_cell(("layout", "shape_overlaps"), has_labels, "boom"),
        "error",
    )

    # referential_integrity_problems (#57): pins both directions -- a real
    # dangling ref/incoming mismatch is caught, and a resolved sequenceFlow
    # (a leaf element with no children) is never misreported as dangling.
    # ET.Element's __bool__ is `len(children) > 0`, not "was this found" --
    # `if not element:` on a found-but-childless element is a live trap this
    # test exists to catch (found live in this codebase during #57: a real
    # regression fixture's every flow was misreported as unresolved).
    clean_root = ET.fromstring(
        '<?xml version="1.0"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D">'
        '<bpmn:process id="P"><bpmn:startEvent id="S"><bpmn:outgoing>F1</bpmn:outgoing></bpmn:startEvent>'
        '<bpmn:task id="T"><bpmn:incoming>F1</bpmn:incoming></bpmn:task>'
        '<bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T" /></bpmn:process></bpmn:definitions>'
    )
    expect("referential_integrity_problems (a fully resolved diagram)", referential_integrity_problems(clean_root), [])
    broken_root = ET.fromstring(
        '<?xml version="1.0"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D">'
        '<bpmn:process id="P"><bpmn:startEvent id="S"><bpmn:outgoing>F1</bpmn:outgoing></bpmn:startEvent>'
        '<bpmn:task id="T"><bpmn:incoming>F_WRONG</bpmn:incoming></bpmn:task>'
        '<bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="MISSING" /></bpmn:process></bpmn:definitions>'
    )
    broken_problems = referential_integrity_problems(broken_root)
    expect("referential_integrity_problems (dangling targetRef is caught)", any("targetRef" in p for p in broken_problems), True)
    expect(
        "referential_integrity_problems (unresolved <incoming> is caught)",
        any("F_WRONG" in p for p in broken_problems),
        True,
    )

    # original_seeded_reason (#62): a curated fixture's "original" column is
    # only a fair, independent reference if its committed DI wasn't itself
    # produced by this engine. Exact and near-identical geometry must both
    # be caught; genuinely different geometry must not be.
    shapes = "".join(
        f'<bpmndi:BPMNShape bpmnElement="S{i}"><dc:Bounds x="{i * 10}" y="0" width="100" height="80" /></bpmndi:BPMNShape>'
        for i in range(10)
    )
    identical_a = (
        '<?xml version="1.0"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" '
        'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" '
        'xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="D"><bpmndi:BPMNDiagram><bpmndi:BPMNPlane>'
        f"{shapes}"
        "</bpmndi:BPMNPlane></bpmndi:BPMNDiagram></bpmn:definitions>"
    )
    identical_b = identical_a.replace('id="D"', 'id="D2"')  # a formatting difference, not a geometry one
    expect(
        "original_seeded_reason (byte-identical geometry is caught)",
        original_seeded_reason(identical_a, identical_b) is not None,
        True,
    )
    near_miss = identical_a.replace('x="0" y="0"', 'x="1" y="0"', 1)  # 1 of 10 shapes nudged 1px
    expect(
        "original_seeded_reason (one nudged coordinate out of many is still caught)",
        original_seeded_reason(identical_a, near_miss) is not None,
        True,
    )
    unrelated = identical_a.replace(shapes, shapes.replace("y=\"0\"", "y=\"500\""))
    expect(
        "original_seeded_reason (genuinely different geometry is not flagged)",
        original_seeded_reason(identical_a, unrelated),
        None,
    )
    expect(
        "original_seeded_reason (no DI at all is not 'seeded', just DI-less)",
        original_seeded_reason("<bpmn:definitions xmlns:bpmn=\"http://www.omg.org/spec/BPMN/20100524/MODEL\" />", ""),
        None,
    )

    if failures:
        raise SystemExit("metric selftests failed:\n" + "\n".join(f"  {failure}" for failure in failures))
    print(f"metric selftests OK: {checks} checks passed against hand-built DI, independent of any layout engine")


def regression(layout_command: list[str] | None = None, structure_only: bool = False) -> None:
    """Lay out each fixture under fixtures/regression/ and assert the one
    invariant it exists to pin -- not image comparison, so a fix elsewhere
    never requires re-blessing a golden file. Add a fixture and an entry in
    REGRESSION_CHECKS whenever an iteration finds a new minimal, single-
    concern reproduction worth keeping (see AGENTS.md)."""
    fixtures = regression_fixtures()
    assert_fixture_references(fixtures, "regression")
    unchecked = sorted(set(fixtures) - set(REGRESSION_CHECKS))
    if unchecked:
        raise SystemExit(f"regression fixtures with no invariant check registered: {', '.join(unchecked)}")
    scratch = Path(".bpmn-feedback") / "regression"
    scratch.mkdir(parents=True, exist_ok=True)
    targets: dict[str, Path] = {}
    for filename, xml in fixtures.items():
        target = scratch / filename
        target.write_text(xml, encoding="utf8")
        targets[filename] = target
    engine_ran = False
    if layout_command:
        engine_ran = layout_fixtures(list(targets.values()), layout_command, structure_only, "regression")
    failures: list[str] = []
    for filename, target in targets.items():
        root = parse_xml(target)
        problems = REGRESSION_CHECKS[filename](root)
        failures.extend(f"{filename}: {problem}" for problem in problems)
    if failures:
        raise SystemExit("regression checks failed:\n" + "\n".join(f"  {failure}" for failure in failures))
    if engine_ran:
        print(f"regression OK: {len(fixtures)} fixtures each satisfy their pinned invariant (with fresh layout-engine output)")
        return
    print(
        f"regression SKIPPED the layout-engine check: {len(fixtures)} fixtures each satisfy their pinned "
        "invariant against persisted DI (--structure-only was passed)",
    )


def latest_report(output_dir: str) -> Path:
    root = Path(output_dir)
    reports = [path for path in root.glob("report-*/index.html") if path.is_file()]
    if not reports:
        raise SystemExit(f"no reports found under {root}")
    return max(reports, key=lambda path: path.stat().st_mtime)


# Maps each quality-gate metric to the §8 priority level (docs/bpmn-layout-rules.json
# LAYOUT_PRIORITY_LEVELS / packages/bpmn-auto-layout/src/layout-policy.ts) it is
# evidence for, so a failing check reports not just *what* is wrong but *how
# important* the requirement it violates is. This is purely a reporting-order
# change: pass/fail behavior (exit non-zero if any failure exists) is unchanged
# (see #29).
METRIC_PRIORITY_LEVEL: dict[str, int] = {
    "ours_engine_error": 1,
    "node_containment_violations": 1,
    "label_containment_violations": 1,
    "invalid_edge_attachments": 1,
    "invalid_label_bounds": 1,
    "edge_container_intersections": 1,
    "degenerate_waypoints": 1,
    "edge_crossings": 2,
    "edge_shape_intersections": 2,
    "shape_overlaps": 2,
    "label_overlaps": 2,
    "label_shape_intersections": 2,
    "label_edge_intersections": 2,
    "non_orthogonal_segments": 3,
    "missing_named_labels": 5,
    "excess_turns": 6,
    "collinear_waypoints": 6,
}


def check_report(args: argparse.Namespace) -> None:
    report = resolve_report_reference(args.report, args.output_dir) if args.report else latest_report(args.output_dir)
    if report.is_dir():
        report /= "index.html"
    metrics_path = report.parent / "metrics.json"
    if not metrics_path.is_file():
        raise SystemExit(f"report metrics do not exist: {metrics_path}")
    document = json.loads(metrics_path.read_text(encoding="utf8"))
    failures: list[tuple[int, str]] = []

    def add(metric: str, text: str) -> None:
        failures.append((METRIC_PRIORITY_LEVEL.get(metric, 99), text))

    for entry in document.get("entries", []):
        title = entry.get("title", entry.get("source", "diagram"))
        # check_report gates only our own engine ("ours") -- a baseline's
        # failures are information for the comparison report, never a build
        # failure (#53). Our own engine erroring out entirely is itself a
        # gate failure: a report where "ours" produced no output cannot
        # certify anything.
        ours = entry.get("engines", {}).get("ours")
        if ours is None:
            raise SystemExit(f"{title}: report has no 'ours' engine column to check")
        if ours.get("metrics") is None:
            add("ours_engine_error", f"{title}: our own engine failed to produce output: {ours.get('error')}")
            continue
        layout = ours["metrics"]["layout"]
        for metric in (
            "edge_crossings",
            "edge_shape_intersections",
            "edge_container_intersections",
            "invalid_edge_attachments",
            "non_orthogonal_segments",
            "degenerate_waypoints",
            "collinear_waypoints",
            "label_overlaps",
            "invalid_label_bounds",
            "shape_overlaps",
            "label_shape_intersections",
            "label_edge_intersections",
            "excess_turns",
            "node_containment_violations",
            "label_containment_violations",
        ):
            value = layout[metric]
            if value > 0:
                add(metric, f"{title}: {metric}={value}")
        for detail in layout.get("excess_turn_details", []):
            add("excess_turns", f"{title}: {detail['edge']} has {detail['excess_turns']} excess turn(s)")
        for detail in layout.get("node_containment_violation_details", []):
            add(
                "node_containment_violations",
                f"{title}: {detail['node']} escapes its {detail['container_type']} {detail['container']}",
            )
        for detail in layout.get("label_containment_violation_details", []):
            add(
                "label_containment_violations",
                f"{title}: label {detail['label']} escapes its {detail['container_type']} {detail['container']}",
            )
        for detail in layout.get("edge_crossing_details", []):
            add("edge_crossings", f"{title}: crossing {detail['first']} x {detail['second']}")
        for detail in layout.get("edge_shape_intersection_details", []):
            add("edge_shape_intersections", f"{title}: {detail['edge']} intersects {detail['shape']}")
        for detail in layout.get("degenerate_waypoint_details", []):
            add("degenerate_waypoints", f"{title}: {detail['edge']} has a duplicated waypoint at {detail['point']}")
        for detail in layout.get("collinear_waypoint_details", []):
            add("collinear_waypoints", f"{title}: {detail['edge']} has a collinear pass-through waypoint at {detail['point']}")
        for detail in layout.get("edge_container_intersection_details", []):
            add("edge_container_intersections", f"{title}: {detail['edge']} intersects container {detail['container']}")
        for detail in layout.get("invalid_edge_attachment_details", []):
            add("invalid_edge_attachments", f"{title}: {detail['edge']} has invalid {detail['end']} attachment")
        for detail in layout.get("label_shape_intersection_details", []):
            add("label_shape_intersections", f"{title}: label {detail['label']} intersects {detail['shape']}")
        for detail in layout.get("label_edge_intersection_details", []):
            add("label_edge_intersections", f"{title}: label {detail['label']} intersects edge {detail['edge']}")
        missing = layout["named_label_coverage"]["missing"]
        if missing > 0:
            add("missing_named_labels", f"{title}: missing_named_labels={missing}")
    # A pinned baseline (e.g. the upstream bpmn-io/bpmn-auto-layout engine,
    # #54) that starts erroring on a fixture it used to handle is a real
    # signal -- a new upstream release broke, or someone's local install
    # drifted -- but it is not a build failure of *our* engine, so it must
    # never affect the exit code (#53's "a baseline's failures are
    # information"). Print it instead: visible in CI logs on every run
    # rather than silently altering what the comparison measures.
    for entry in document.get("entries", []):
        title = entry.get("title", entry.get("source", "diagram"))
        for name, column in entry.get("engines", {}).items():
            if name != "ours" and column.get("error"):
                print(f"baseline engine {name!r} failed on {title}: {column['error']}")
    if failures:
        failures.sort(key=lambda item: item[0])
        lines = [f"  [L{level}] {text}" if level != 99 else f"  {text}" for level, text in failures]
        raise SystemExit("layout checks failed (ordered by §8 priority level, most important first):\n" + "\n".join(lines))
    print(f"layout checks passed: {report}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    report = subparsers.add_parser("report", help="layout, render, and metric BPMN files")
    report.add_argument("inputs", nargs="*", help="BPMN files; omitted means persisted fixtures")
    report.add_argument("--output-dir", default=".bpmn-feedback/reports", help="workspace-local ephemeral report directory root")
    report.add_argument("--clear-output", action="store_true", help="remove previous report directories before rendering")
    report.add_argument("--layout-command", default="bpmn-auto-layout", help="our own engine's layout command, shell-style string")
    report.add_argument(
        "--engine",
        action="append",
        dest="engines",
        default=[],
        metavar="NAME=COMMAND",
        help='additional named engine to compare against, e.g. --engine upstream="npx bpmn-auto-layout@1.3.0" '
        "(repeatable; our own engine is always included as 'ours' unless overridden with --engine ours=...)",
    )
    report.add_argument("--image-command", default="bpmn-to-image", help="image command, shell-style string")

    latest = subparsers.add_parser("latest", help="print the newest report index path")
    latest.add_argument("--output-dir", default=".bpmn-feedback/reports", help="report directory root")

    check = subparsers.add_parser("check", help="fail if our own engine's report metrics contain layout defects")
    check.add_argument("--report", help="report HTML path or report directory; omitted means newest report")
    check.add_argument("--output-dir", default=".bpmn-feedback/reports", help="report directory root")

    subparsers.add_parser(
        "metric-selftest",
        help="pin every audited metric to a value verified against hand-built DI, independent of any layout engine",
    )

    selftest_parser = subparsers.add_parser(
        "selftest",
        help="re-verify persisted fixtures against fresh layout-engine output (fails if no engine is available)",
    )
    selftest_parser.add_argument(
        "--layout-command",
        default="bpmn-auto-layout",
        help="layout command, shell-style string; tried before falling back to running the built engine via node",
    )
    selftest_parser.add_argument(
        "--structure-only",
        action="store_true",
        help="skip the layout-engine check entirely and validate persisted DI as-is; without this flag, "
        "selftest exits non-zero when no engine (CLI or built dist/) is available",
    )

    regression_parser = subparsers.add_parser(
        "regression",
        help="lay out fixtures/regression/*.bpmn and assert each one's pinned invariant (fails if no engine is available)",
    )
    regression_parser.add_argument(
        "--layout-command",
        default="bpmn-auto-layout",
        help="layout command, shell-style string; tried before falling back to running the built engine via node",
    )
    regression_parser.add_argument(
        "--structure-only",
        action="store_true",
        help="skip the layout-engine check entirely and check persisted DI as-is; without this flag, "
        "regression exits non-zero when no engine (CLI or built dist/) is available",
    )

    stability_parser = subparsers.add_parser(
        "stability",
        help="lay out BASE and VARIANT and report how much geometry shared between them moved",
    )
    stability_parser.add_argument("base", help="baseline BPMN file")
    stability_parser.add_argument("variant", help="variant BPMN file (e.g. base plus one unrelated element)")
    stability_parser.add_argument("--layout-command", default="bpmn-auto-layout", help="layout command, shell-style string")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "report":
        report_path = render_report(args)
        print(f"report: {report_path}")
        print(f"Short report ID: {report_path.parent.name.removeprefix('report-')}")
        print_host_view_command(report_path)
    elif args.command == "latest":
        print(latest_report(args.output_dir))
    elif args.command == "check":
        check_report(args)
    elif args.command == "metric-selftest":
        metric_selftests()
    elif args.command == "selftest":
        selftest(split_command(args.layout_command), args.structure_only)
    elif args.command == "regression":
        regression(split_command(args.layout_command), args.structure_only)
    elif args.command == "stability":
        result = stability(Path(args.base), Path(args.variant), split_command(args.layout_command))
        print(json.dumps(result, indent=2, sort_keys=True))
        shapes = result["shapes"]  # type: ignore[index]
        edges = result["edges"]  # type: ignore[index]
        print(
            f"stability: {shapes['moved']}/{shapes['common']} shapes moved, "  # type: ignore[index]
            f"{edges['changed']}/{edges['common']} edges changed waypoints",  # type: ignore[index]
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
