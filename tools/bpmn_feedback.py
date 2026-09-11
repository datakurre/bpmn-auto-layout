#!/usr/bin/env python3
"""Read persisted BPMN fixtures, generate reports, and run quality checks."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import os
import shlex
import shutil
import subprocess
import tempfile
from collections.abc import Callable
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


def orthogonal_cross(a1: tuple[float, float], a2: tuple[float, float], b1: tuple[float, float], b2: tuple[float, float]) -> bool:
    a_horizontal = abs(a1[1] - a2[1]) < 0.5
    b_horizontal = abs(b1[1] - b2[1]) < 0.5
    if a_horizontal == b_horizontal:
        return False
    h1, h2, v1, v2 = (a1, a2, b1, b2) if a_horizontal else (b1, b2, a1, a2)
    x = v1[0]
    y = h1[1]
    return min(h1[0], h2[0]) < x < max(h1[0], h2[0]) and min(v1[1], v2[1]) < y < max(v1[1], v2[1])


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
    horizontal_flow_gaps: list[float] = []
    excess_turns_total = 0
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
        total_bends += max(0, len(points) - 2)
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
                owned = [element_parents.get(endpoint) == container_id for endpoint in endpoints if endpoint]
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
                    edge_container_intersections += 1
                    edge_container_intersection_details.append(
                        {"edge": str(edge["bpmnElement"]), "container": container_id}
                    )
        if points and len(points) >= 2 and source_bounds and target_bounds:
            source_side = attach_side(points[0], source_bounds)
            target_side = attach_side(points[-1], target_bounds)
            if source_side and target_side:
                actual_bends = max(0, len(points) - 2)
                baseline_bends = min_bend_count(points[0], source_side, points[-1], target_side)
                excess = max(0, actual_bends - baseline_bends)
                if excess > 0:
                    excess_turns_total += excess
                    excess_turn_details.append({"edge": str(edge["bpmnElement"]), "excess_turns": excess})
            port_distance = abs(points[0][0] - points[-1][0]) + abs(points[0][1] - points[-1][1])
            if port_distance > 0.5:
                detour_ratios.append(edge_manhattan / port_distance)
    excess_turn_details.sort(key=lambda detail: -int(detail["excess_turns"]))  # type: ignore[arg-type]
    for i, first in enumerate(edges):
        first_points = first["points"]  # type: ignore[assignment]
        first_endpoints = set(flow_endpoints.get(first["bpmnElement"], (None, None)))  # type: ignore[arg-type]
        for second in edges[i + 1 :]:
            if first["plane"] != second["plane"]:
                continue
            if first_endpoints.intersection(set(flow_endpoints.get(second["bpmnElement"], (None, None)))):  # type: ignore[arg-type]
                continue
            second_points = second["points"]  # type: ignore[assignment]
            for a1, a2 in zip(first_points, first_points[1:]):
                for b1, b2 in zip(second_points, second_points[1:]):
                    if orthogonal_cross(a1, a2, b1, b2):
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
            "excess_turns": excess_turns_total,
            "excess_turn_details": excess_turn_details,
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


def resolve_dist_index() -> Path | None:
    """The built layout engine, importable directly by `node` -- no CLI, no
    nix. Exists once `npm run build` has run inside packages/bpmn-auto-layout;
    None when the package has not been built here."""
    candidate = repo_root() / "packages" / "bpmn-auto-layout" / "dist" / "index.js"
    return candidate if candidate.is_file() else None


def layout_via_node(dist_index: Path, targets: list[Path]) -> None:
    """Lay out every file in `targets` in place by importing layoutProcess
    from the built package directly, bypassing the bpmn-auto-layout CLI
    wrapper flake.nix defines. Works in any environment with the package
    already built -- a plain CI runner, a container, an agent working
    directly in the repo -- not only inside `nix develop` (#43)."""
    node = shutil.which("node")
    if not node:
        raise SystemExit("node not found on PATH; cannot run the layout engine directly")
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
        script_path = Path(handle.name)
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


def clear_reports(output_dir: str) -> None:
    root = Path(output_dir)
    if not root.exists():
        return
    for report in root.glob("report-*"):
        if report.is_dir() and not report.is_symlink():
            shutil.rmtree(report)


def render_report(args: argparse.Namespace) -> Path:
    report_root = Path(args.output_dir)
    report_root.mkdir(parents=True, exist_ok=True)
    if args.clear_output:
        clear_reports(args.output_dir)
    workdir = Path(tempfile.mkdtemp(prefix="report-", dir=report_root))
    inputs = [Path(path) for path in args.inputs]
    if not inputs:
        inputs = [Path("fixtures") / filename for filename in sorted(persisted_fixtures())]
    layout_command = split_command(args.layout_command)
    image_command = split_command(args.image_command)

    entries: list[dict[str, object]] = []
    for index, source in enumerate(inputs, start=1):
        if not source.exists():
            raise SystemExit(f"input BPMN does not exist: {source}")
        part_dir = workdir / f"part-{index:02d}-{source.stem}"
        part_dir.mkdir()
        original_bpmn = part_dir / "original.bpmn"
        transformed_bpmn = part_dir / "transformed.bpmn"
        shutil.copyfile(source, original_bpmn)
        shutil.copyfile(source, transformed_bpmn)
        run_command(layout_command + [str(transformed_bpmn)], f"layout {source}")
        original_svg = part_dir / "original.svg"
        transformed_svg = part_dir / "transformed.svg"
        run_command(image_command + [str(original_bpmn), str(original_svg)], f"render original {source}")
        run_command(image_command + [str(transformed_bpmn), str(transformed_svg)], f"render transformed {source}")
        original_metrics = collect_metrics(original_bpmn)
        transformed_metrics = collect_metrics(transformed_bpmn)
        entries.append(
            {
                "title": source.name,
                "source": str(source),
                "directory": part_dir.name,
                "original_bpmn": str(original_bpmn.relative_to(workdir)),
                "transformed_bpmn": str(transformed_bpmn.relative_to(workdir)),
                "original_svg": str(original_svg.relative_to(workdir)),
                "transformed_svg": str(transformed_svg.relative_to(workdir)),
                "original_metrics": original_metrics,
                "transformed_metrics": transformed_metrics,
            }
        )

    metrics_doc = {"schema": "bpmn-layout-report/v1", "entries": entries}
    (workdir / "metrics.json").write_text(json.dumps(metrics_doc, indent=2, sort_keys=True) + "\n", encoding="utf8")
    (workdir / "index.html").write_text(report_html(metrics_doc), encoding="utf8")
    return workdir / "index.html"


def metric_rows(original: dict[str, object], transformed: dict[str, object]) -> str:
    paths = [
        ("diagrams", ("layout", "diagrams")),
        ("shapes", ("layout", "shapes")),
        ("edges", ("layout", "edges")),
        ("labels", ("layout", "labels")),
        ("shape overlaps", ("layout", "shape_overlaps")),
        ("label overlaps", ("layout", "label_overlaps")),
        ("edge crossings", ("layout", "edge_crossings")),
        ("edge/shape intersections", ("layout", "edge_shape_intersections")),
        ("node containment violations", ("layout", "node_containment_violations")),
        ("label containment violations", ("layout", "label_containment_violations")),
        ("total bends", ("layout", "total_bends")),
        ("degenerate waypoints", ("layout", "degenerate_waypoints")),
        ("excess turns", ("layout", "excess_turns")),
        ("detour ratio average", ("layout", "detour_ratio", "avg")),
        ("detour ratio maximum", ("layout", "detour_ratio", "max")),
        ("total Manhattan length", ("layout", "total_manhattan_length")),
        ("non-50px route segments", ("layout", "route_lattice", "non_multiple_segments")),
        ("maximum route lattice remainder", ("layout", "route_lattice", "max_remainder")),
        ("grid center-x avg deviation", ("layout", "grid_center_x_deviation_avg")),
        ("event label gap average", ("layout", "node_label_gap", "event", "avg")),
        ("gateway label gap average", ("layout", "node_label_gap", "gateway", "avg")),
        ("event label gap minimum", ("layout", "node_label_gap", "event", "min")),
        ("gateway label gap minimum", ("layout", "node_label_gap", "gateway", "min")),
        ("horizontal flow gap average", ("layout", "horizontal_flow_gap", "avg")),
        ("horizontal flow gap minimum", ("layout", "horizontal_flow_gap", "min")),
        ("horizontal flow gap maximum", ("layout", "horizontal_flow_gap", "max")),
        ("missing named labels", ("layout", "named_label_coverage", "missing")),
        ("sequence flows", ("semantic", "sequence_flows")),
        ("message flows", ("semantic", "message_flows")),
        ("lanes", ("semantic", "lanes")),
        ("data references", ("semantic", "data_references")),
    ]

    def get(doc: dict[str, object], path: tuple[str, ...]) -> object:
        current: object = doc
        for key in path:
            current = current[key]  # type: ignore[index]
        return current

    rows = []
    for label, path in paths:
        before = get(original, path)
        after = get(transformed, path)
        rows.append(f"<tr><th>{html.escape(label)}</th><td>{html.escape(str(before))}</td><td>{html.escape(str(after))}</td></tr>")
    return "\n".join(rows)


def report_html(metrics_doc: dict[str, object]) -> str:
    entries = metrics_doc["entries"]  # type: ignore[index]
    sections: list[str] = []
    for entry in entries:  # type: ignore[assignment]
        title = html.escape(entry["title"])
        original_svg = html.escape(entry["original_svg"])
        transformed_svg = html.escape(entry["transformed_svg"])
        original_metrics = entry["original_metrics"]
        transformed_metrics = entry["transformed_metrics"]
        sections.append(
            f"""
<section class="part">
  <h2>{title}</h2>
  <p><strong>Source:</strong> {html.escape(entry['source'])}</p>
  <h3>Images</h3>
  <div class="images">
    <figure><figcaption>Original</figcaption><img src="{original_svg}" alt="Original BPMN image for {title}"></figure>
    <figure><figcaption>Transformed</figcaption><img src="{transformed_svg}" alt="Transformed BPMN image for {title}"></figure>
  </div>
  <h3>Deterministic metrics</h3>
  <table><thead><tr><th>Metric</th><th>Original</th><th>Transformed</th></tr></thead><tbody>
    {metric_rows(original_metrics, transformed_metrics)}
  </tbody></table>
  <details><summary>Original metrics JSON</summary><pre>{html.escape(json.dumps(original_metrics, indent=2, sort_keys=True))}</pre></details>
  <details><summary>Transformed metrics JSON</summary><pre>{html.escape(json.dumps(transformed_metrics, indent=2, sort_keys=True))}</pre></details>
</section>
"""
        )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>BPMN layout feedback report</title>
<style>
body {{ font-family: sans-serif; margin: 2rem; color: #1f2328; }}
.part {{ border-top: 1px solid #d0d7de; padding-top: 1.5rem; margin-top: 1.5rem; }}
.images {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }}
figure {{ margin: 0; border: 1px solid #d0d7de; padding: .75rem; overflow: auto; }}
figcaption {{ font-weight: 600; margin-bottom: .5rem; }}
img {{ max-width: 100%; background: white; }}
table {{ border-collapse: collapse; margin: 1rem 0; }}
th, td {{ border: 1px solid #d0d7de; padding: .35rem .5rem; text-align: right; }}
th:first-child {{ text-align: left; }}
pre {{ overflow: auto; background: #f6f8fa; padding: 1rem; }}
</style>
</head>
<body>
<h1>BPMN layout feedback report</h1>
<p>This report is ephemeral and workspace-local. Metrics are also available in <a href="metrics.json">metrics.json</a>.</p>
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


def selftest(layout_command: list[str] | None = None, structure_only: bool = False) -> None:
    first = persisted_fixtures()
    second = persisted_fixtures()
    if first != second:
        raise SystemExit("persisted fixture set changed while being read")
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


REGRESSION_CHECKS: dict[str, Callable[[ET.Element], list[str]]] = {
    "boundary-events-three-on-one-host.bpmn": check_boundary_events_distinct,
    "lanes-without-collaboration.bpmn": check_lane_bands_tile,
    "subprocess-internal-branch.bpmn": check_subprocess_internal_edges_stay_inside,
    "gateway-same-track-bypass.bpmn": check_gateway_bypass_avoids_sibling,
    "gateway-bidirectional-bypass.bpmn": check_gateway_loop_bypasses_sibling_without_degenerate_waypoints,
}


def regression(layout_command: list[str] | None = None, structure_only: bool = False) -> None:
    """Lay out each fixture under fixtures/regression/ and assert the one
    invariant it exists to pin -- not image comparison, so a fix elsewhere
    never requires re-blessing a golden file. Add a fixture and an entry in
    REGRESSION_CHECKS whenever an iteration finds a new minimal, single-
    concern reproduction worth keeping (see AGENTS.md)."""
    fixtures = regression_fixtures()
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
        layout = entry["transformed_metrics"]["layout"]
        for metric in (
            "edge_crossings",
            "edge_shape_intersections",
            "edge_container_intersections",
            "invalid_edge_attachments",
            "non_orthogonal_segments",
            "degenerate_waypoints",
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
    report.add_argument("--layout-command", default="bpmn-auto-layout", help="layout command, shell-style string")
    report.add_argument("--image-command", default="bpmn-to-image", help="image command, shell-style string")

    latest = subparsers.add_parser("latest", help="print the newest report index path")
    latest.add_argument("--output-dir", default=".bpmn-feedback/reports", help="report directory root")

    check = subparsers.add_parser("check", help="fail if transformed report metrics contain layout defects")
    check.add_argument("--report", help="report HTML path or report directory; omitted means newest report")
    check.add_argument("--output-dir", default=".bpmn-feedback/reports", help="report directory root")

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
