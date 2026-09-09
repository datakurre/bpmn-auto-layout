#!/usr/bin/env python3
"""Generate BPMN layout fixtures, render reports, and collect feedback."""
from __future__ import annotations

import argparse
import datetime as _datetime
import hashlib
import html
import json
import math
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {
    "bpmn": "http://www.omg.org/spec/BPMN/20100524/MODEL",
    "bpmndi": "http://www.omg.org/spec/BPMN/20100524/DI",
    "dc": "http://www.omg.org/spec/DD/20100524/DC",
    "di": "http://www.omg.org/spec/DD/20100524/DI",
    "xsi": "http://www.w3.org/2001/XMLSchema-instance",
}

for prefix, uri in NS.items():
    ET.register_namespace(prefix, uri)

EVENT_DEFINITION_TAGS = {
    "message": "messageEventDefinition",
    "timer": "timerEventDefinition",
    "error": "errorEventDefinition",
    "signal": "signalEventDefinition",
}

CONTAINER_TYPES = {"lane", "participant", "subProcess"}
CHOICES = [
    "edge-crossings",
    "edge-overlaps-element",
    "label-overlaps-element",
    "label-too-far",
    "shape-spacing",
    "gateway-branching",
    "loop-routing",
    "subprocess-or-boundary",
    "lanes-or-pools",
    "messages-or-data",
    "other",
]
RATINGS = ["overall", "readability", "flow-clarity", "routing-quality", "label-quality"]


def q(prefix: str, local: str) -> str:
    return f"{{{NS[prefix]}}}{local}"


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def bpmn_tag(kind: str) -> str:
    return kind[:1].lower() + kind[1:]


@dataclass(frozen=True)
class EventDefinition:
    kind: str
    attrs: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Node:
    id: str
    kind: str
    name: str = ""
    x: int = 0
    y: int = 0
    width: int | None = None
    height: int | None = None
    attrs: dict[str, str] = field(default_factory=dict)
    event_definitions: tuple[EventDefinition, ...] = ()
    children: tuple["Node", ...] = ()
    child_flows: tuple["Flow", ...] = ()


@dataclass(frozen=True)
class Flow:
    id: str
    source: str
    target: str
    name: str = ""
    kind: str = "sequenceFlow"


@dataclass(frozen=True)
class Lane:
    id: str
    name: str
    refs: tuple[str, ...]
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class Participant:
    id: str
    name: str
    process_ref: str
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class ProcessSpec:
    id: str
    name: str
    nodes: tuple[Node, ...]
    flows: tuple[Flow, ...]
    lanes: tuple[Lane, ...] = ()
    is_executable: bool = False


@dataclass(frozen=True)
class FixtureSpec:
    filename: str
    definitions_id: str
    processes: tuple[ProcessSpec, ...]
    messages: tuple[tuple[str, str], ...] = ()
    data_stores: tuple[tuple[str, str], ...] = ()
    collaborations: tuple[str, str, tuple[Participant, ...], tuple[Flow, ...]] | None = None


def default_size(kind: str) -> tuple[int, int]:
    if kind.endswith("Event"):
        return (36, 36)
    if kind.endswith("Gateway"):
        return (50, 50)
    if kind == "SubProcess":
        return (360, 200)
    if kind in {"DataObjectReference", "DataStoreReference"}:
        return (50, 64)
    return (100, 80)


def add_text(parent: ET.Element, tag: str, text: str) -> None:
    child = ET.SubElement(parent, q("bpmn", tag))
    child.text = text


def node_size(node: Node) -> tuple[int, int]:
    width, height = default_size(node.kind)
    return (node.width or width, node.height or height)


def all_nodes(process: ProcessSpec) -> dict[str, Node]:
    nodes: dict[str, Node] = {}

    def visit(node: Node) -> None:
        nodes[node.id] = node
        for child in node.children:
            visit(child)

    for node in process.nodes:
        visit(node)
    return nodes


def add_bpmn_node(parent: ET.Element, node: Node, incoming: dict[str, list[str]], outgoing: dict[str, list[str]]) -> None:
    attrs = {"id": node.id}
    if node.name:
        attrs["name"] = node.name
    attrs.update(node.attrs)
    element = ET.SubElement(parent, q("bpmn", bpmn_tag(node.kind)), attrs)
    for flow_id in incoming.get(node.id, []):
        add_text(element, "incoming", flow_id)
    for flow_id in outgoing.get(node.id, []):
        add_text(element, "outgoing", flow_id)
    for event_definition in node.event_definitions:
        tag = EVENT_DEFINITION_TAGS[event_definition.kind]
        ev_attrs = {"id": f"{node.id}_{tag}"}
        ev_attrs.update(event_definition.attrs)
        ET.SubElement(element, q("bpmn", tag), ev_attrs)
    if node.kind == "SubProcess":
        child_incoming, child_outgoing = flow_maps(node.child_flows)
        for child in node.children:
            add_bpmn_node(element, child, child_incoming, child_outgoing)
        for flow in node.child_flows:
            add_bpmn_flow(element, flow)


def add_bpmn_flow(parent: ET.Element, flow: Flow) -> None:
    attrs = {"id": flow.id, "sourceRef": flow.source, "targetRef": flow.target}
    if flow.name:
        attrs["name"] = flow.name
    ET.SubElement(parent, q("bpmn", flow.kind), attrs)


def flow_maps(flows: tuple[Flow, ...]) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    incoming: dict[str, list[str]] = {}
    outgoing: dict[str, list[str]] = {}
    for flow in flows:
        outgoing.setdefault(flow.source, []).append(flow.id)
        incoming.setdefault(flow.target, []).append(flow.id)
    return incoming, outgoing


def label_bounds(x: int, y: int, width: int, height: int, kind: str) -> tuple[int, int, int, int]:
    if kind == "Lane":
        return (x + 12, y + 8, min(120, max(60, height - 20)), 20)
    if kind.endswith("Event") or kind.endswith("Gateway"):
        return (round(x + width / 2 - 45), y + height + 6, 90, 20)
    return (x, y + height + 4, 90, 20)


def add_label(parent: ET.Element, bounds: tuple[int, int, int, int]) -> None:
    label = ET.SubElement(parent, q("bpmndi", "BPMNLabel"))
    x, y, width, height = bounds
    ET.SubElement(label, q("dc", "Bounds"), {"x": str(x), "y": str(y), "width": str(width), "height": str(height)})


def add_shape(plane: ET.Element, bpmn_id: str, x: int, y: int, width: int, height: int, kind: str, name: str = "") -> None:
    attrs = {"id": f"{bpmn_id}_di", "bpmnElement": bpmn_id}
    if kind.endswith("Gateway"):
        attrs["isMarkerVisible"] = "true"
    if kind == "SubProcess":
        attrs["isExpanded"] = "true"
    shape = ET.SubElement(plane, q("bpmndi", "BPMNShape"), attrs)
    ET.SubElement(shape, q("dc", "Bounds"), {"x": str(x), "y": str(y), "width": str(width), "height": str(height)})
    if name and (kind.endswith("Event") or kind.endswith("Gateway") or kind == "Lane"):
        add_label(shape, label_bounds(x, y, width, height, kind))


def waypoint_between(source: Node, target: Node) -> list[tuple[int, int]]:
    sw, sh = node_size(source)
    tw, th = node_size(target)
    sx, sy = source.x + sw, source.y + sh // 2
    tx, ty = target.x, target.y + th // 2
    if target.x <= source.x:
        lane_y = max(source.y + sh, target.y + th) + 55
        return [(source.x + sw // 2, source.y + sh), (source.x + sw // 2, lane_y), (target.x + tw // 2, lane_y), (target.x + tw // 2, target.y + th)]
    if sy == ty:
        return [(sx, sy), (tx, ty)]
    mid_x = round((sx + tx) / 2)
    return [(sx, sy), (mid_x, sy), (mid_x, ty), (tx, ty)]


def add_edge(plane: ET.Element, flow: Flow, nodes: dict[str, Node], label: bool = True) -> None:
    edge = ET.SubElement(plane, q("bpmndi", "BPMNEdge"), {"id": f"{flow.id}_di", "bpmnElement": flow.id})
    for x, y in waypoint_between(nodes[flow.source], nodes[flow.target]):
        ET.SubElement(edge, q("di", "waypoint"), {"x": str(x), "y": str(y)})
    if label and flow.name:
        points = [(int(point.get("x", "0")), int(point.get("y", "0"))) for point in edge.findall(q("di", "waypoint"))]
        a, b = points[min(1, len(points) - 1)], points[min(2, len(points) - 1)]
        x = round((a[0] + b[0]) / 2 - 35)
        y = round((a[1] + b[1]) / 2 - 18)
        add_label(edge, (x, max(0, y), 70, 14))


def fixture_specs() -> list[FixtureSpec]:
    basic = ProcessSpec(
        id="Process_BasicEventsTasks",
        name="Basic events and tasks",
        nodes=(
            Node("Start_Order", "StartEvent", "Order received", 60, 110),
            Node("Task_Validate", "UserTask", "Validate order", 150, 88),
            Node("Task_Charge", "ServiceTask", "Charge payment", 310, 88),
            Node("Throw_Receipt", "IntermediateThrowEvent", "Send receipt", 480, 110, event_definitions=(EventDefinition("message", {"messageRef": "Message_Receipt"}),)),
            Node("End_Fulfilled", "EndEvent", "Fulfilled", 610, 110),
        ),
        flows=(
            Flow("Flow_Order_To_Validate", "Start_Order", "Task_Validate"),
            Flow("Flow_Validate_To_Charge", "Task_Validate", "Task_Charge", "valid"),
            Flow("Flow_Charge_To_Receipt", "Task_Charge", "Throw_Receipt", "paid"),
            Flow("Flow_Receipt_To_End", "Throw_Receipt", "End_Fulfilled"),
        ),
    )

    branches = ProcessSpec(
        id="Process_GatewaysBranchesLoops",
        name="Gateways, branches, and loops",
        nodes=(
            Node("Start_Draft", "StartEvent", "Draft ready", 60, 160),
            Node("Task_Draft", "Task", "Prepare draft", 150, 138),
            Node("Gateway_ReviewNeeded", "ExclusiveGateway", "Need review?", 310, 153),
            Node("Task_Review", "UserTask", "Review draft", 430, 138),
            Node("Gateway_Accepted", "ExclusiveGateway", "Accepted?", 590, 153),
            Node("Task_Revise", "Task", "Revise draft", 430, 300),
            Node("End_Cancelled", "EndEvent", "Cancelled", 430, 40),
            Node("Task_Publish", "ServiceTask", "Publish", 730, 138),
            Node("Gateway_Split", "ParallelGateway", "Notify and archive", 890, 153),
            Node("Task_Notify", "SendTask", "Notify requester", 1020, 48),
            Node("Task_Archive", "ServiceTask", "Archive package", 1020, 250),
            Node("Gateway_Join", "ParallelGateway", "Done?", 1190, 153),
            Node("End_Published", "EndEvent", "Published", 1320, 160),
        ),
        flows=(
            Flow("Flow_Start_Draft", "Start_Draft", "Task_Draft"),
            Flow("Flow_Draft_Gateway", "Task_Draft", "Gateway_ReviewNeeded"),
            Flow("Flow_NoReview_Publish", "Gateway_ReviewNeeded", "Task_Publish", "no"),
            Flow("Flow_ReviewNeeded", "Gateway_ReviewNeeded", "Task_Review", "yes"),
            Flow("Flow_Review_Accepted", "Task_Review", "Gateway_Accepted"),
            Flow("Flow_Accepted_Publish", "Gateway_Accepted", "Task_Publish", "accepted"),
            Flow("Flow_Changes_Revise", "Gateway_Accepted", "Task_Revise", "changes"),
            Flow("Flow_Revise_Back_To_Review", "Task_Revise", "Task_Review", "retry"),
            Flow("Flow_Cancelled", "Gateway_ReviewNeeded", "End_Cancelled", "reject"),
            Flow("Flow_Publish_Split", "Task_Publish", "Gateway_Split"),
            Flow("Flow_Split_Notify", "Gateway_Split", "Task_Notify"),
            Flow("Flow_Split_Archive", "Gateway_Split", "Task_Archive"),
            Flow("Flow_Notify_Join", "Task_Notify", "Gateway_Join"),
            Flow("Flow_Archive_Join", "Task_Archive", "Gateway_Join"),
            Flow("Flow_Join_End", "Gateway_Join", "End_Published"),
        ),
    )

    subprocess = ProcessSpec(
        id="Process_SubprocessBoundaryDataLanes",
        name="Subprocess, boundary event, data, and lanes",
        nodes=(
            Node("Start_Request", "StartEvent", "Request", 80, 85),
            Node("Task_Submit", "UserTask", "Submit request", 170, 63),
            Node(
                "SubProcess_Handle",
                "SubProcess",
                "Handle request",
                330,
                220,
                children=(
                    Node("Sub_Start", "StartEvent", "Begin", 365, 302),
                    Node("Sub_Task_Check", "ServiceTask", "Check inventory", 435, 280),
                    Node("Sub_End", "EndEvent", "Ready", 590, 302),
                ),
                child_flows=(
                    Flow("Sub_Flow_Start_Check", "Sub_Start", "Sub_Task_Check"),
                    Flow("Sub_Flow_Check_End", "Sub_Task_Check", "Sub_End"),
                ),
            ),
            Node("Boundary_Timeout", "BoundaryEvent", "Timeout", 640, 320, attrs={"attachedToRef": "SubProcess_Handle"}, event_definitions=(EventDefinition("timer"),)),
            Node("Task_Escalate", "SendTask", "Escalate", 750, 430),
            Node("Data_Order", "DataObjectReference", "Order data", 170, 170, attrs={"dataObjectRef": "DataObject_Order"}),
            Node("Store_Inventory", "DataStoreReference", "Inventory store", 520, 485, attrs={"dataStoreRef": "DataStore_Inventory"}),
            Node("End_Handled", "EndEvent", "Handled", 760, 302),
            Node("End_Escalated", "EndEvent", "Escalated", 910, 452),
        ),
        flows=(
            Flow("Flow_Request_Submit", "Start_Request", "Task_Submit"),
            Flow("Flow_Submit_Handle", "Task_Submit", "SubProcess_Handle"),
            Flow("Flow_Handle_End", "SubProcess_Handle", "End_Handled"),
            Flow("Flow_Timeout_Escalate", "Boundary_Timeout", "Task_Escalate", "timeout"),
            Flow("Flow_Escalate_End", "Task_Escalate", "End_Escalated"),
        ),
        lanes=(
            Lane("Lane_Requester", "Requester", ("Start_Request", "Task_Submit", "Data_Order"), 40, 40, 960, 180),
            Lane("Lane_Automation", "Automation", ("SubProcess_Handle", "Boundary_Timeout", "Task_Escalate", "Store_Inventory", "End_Handled", "End_Escalated"), 40, 220, 960, 360),
        ),
    )

    customer = ProcessSpec(
        id="Process_Customer",
        name="Customer",
        nodes=(
            Node("Start_Customer", "StartEvent", "Need goods", 110, 108),
            Node("Task_SendOrder", "SendTask", "Send order", 210, 86),
            Node("Catch_Confirmation", "IntermediateCatchEvent", "Receive confirmation", 380, 108, event_definitions=(EventDefinition("message", {"messageRef": "Message_Confirmation"}),)),
            Node("End_Customer", "EndEvent", "Confirmed", 520, 108),
        ),
        flows=(
            Flow("Flow_Customer_Start_Send", "Start_Customer", "Task_SendOrder"),
            Flow("Flow_Customer_Send_Catch", "Task_SendOrder", "Catch_Confirmation"),
            Flow("Flow_Customer_Catch_End", "Catch_Confirmation", "End_Customer"),
        ),
    )
    supplier = ProcessSpec(
        id="Process_Supplier",
        name="Supplier",
        nodes=(
            Node("Start_OrderMessage", "StartEvent", "Order message", 110, 328, event_definitions=(EventDefinition("message", {"messageRef": "Message_Order"}),)),
            Node("Task_ReserveStock", "ServiceTask", "Reserve stock", 210, 306),
            Node("Task_SendConfirmation", "SendTask", "Send confirmation", 380, 306),
            Node("End_Supplier", "EndEvent", "Sent", 550, 328),
        ),
        flows=(
            Flow("Flow_Supplier_Start_Reserve", "Start_OrderMessage", "Task_ReserveStock"),
            Flow("Flow_Supplier_Reserve_Send", "Task_ReserveStock", "Task_SendConfirmation"),
            Flow("Flow_Supplier_Send_End", "Task_SendConfirmation", "End_Supplier"),
        ),
    )

    return [
        FixtureSpec("basic-events-tasks.bpmn", "Definitions_BasicEventsTasks", (basic,), messages=(("Message_Receipt", "Receipt"),)),
        FixtureSpec("gateways-branches-loops.bpmn", "Definitions_GatewaysBranchesLoops", (branches,)),
        FixtureSpec(
            "subprocess-boundary-data-lanes.bpmn",
            "Definitions_SubprocessBoundaryDataLanes",
            (subprocess,),
            data_stores=(("DataStore_Inventory", "Inventory"),),
        ),
        FixtureSpec(
            "collaboration-lanes-messages.bpmn",
            "Definitions_CollaborationMessages",
            (customer, supplier),
            messages=(("Message_Order", "Order"), ("Message_Confirmation", "Confirmation")),
            collaborations=(
                "Collaboration_OrderFulfilment",
                "Order fulfilment collaboration",
                (
                    Participant("Participant_Customer", "Customer", "Process_Customer", 70, 60, 570, 150),
                    Participant("Participant_Supplier", "Supplier", "Process_Supplier", 70, 280, 620, 150),
                ),
                (
                    Flow("MessageFlow_Order", "Task_SendOrder", "Start_OrderMessage", "order", "messageFlow"),
                    Flow("MessageFlow_Confirmation", "Task_SendConfirmation", "Catch_Confirmation", "confirmation", "messageFlow"),
                ),
            ),
        ),
    ]


def append_process(root: ET.Element, process: ProcessSpec) -> None:
    attrs = {"id": process.id, "isExecutable": "true" if process.is_executable else "false"}
    if process.name:
        attrs["name"] = process.name
    proc = ET.SubElement(root, q("bpmn", "process"), attrs)
    if process.lanes:
        lane_set = ET.SubElement(proc, q("bpmn", "laneSet"), {"id": f"LaneSet_{process.id}"})
        for lane in process.lanes:
            lane_el = ET.SubElement(lane_set, q("bpmn", "lane"), {"id": lane.id, "name": lane.name})
            for ref in lane.refs:
                add_text(lane_el, "flowNodeRef", ref)
    incoming, outgoing = flow_maps(process.flows)
    for node in process.nodes:
        if node.kind == "DataObjectReference":
            ET.SubElement(proc, q("bpmn", "dataObject"), {"id": node.attrs.get("dataObjectRef", f"{node.id}_Object")})
        add_bpmn_node(proc, node, incoming, outgoing)
    for flow in process.flows:
        add_bpmn_flow(proc, flow)


def append_diagram(root: ET.Element, plane_id: str, bpmn_element: str, processes: tuple[ProcessSpec, ...], participants: tuple[Participant, ...] = (), message_flows: tuple[Flow, ...] = ()) -> None:
    diagram = ET.SubElement(root, q("bpmndi", "BPMNDiagram"), {"id": f"BPMNDiagram_{plane_id}"})
    plane = ET.SubElement(diagram, q("bpmndi", "BPMNPlane"), {"id": f"BPMNPlane_{plane_id}", "bpmnElement": bpmn_element})
    all_by_id: dict[str, Node] = {}
    for participant in participants:
        add_shape(plane, participant.id, participant.x, participant.y, participant.width, participant.height, "Participant", participant.name)
    for process in processes:
        all_by_id.update(all_nodes(process))
        for lane in process.lanes:
            add_shape(plane, lane.id, lane.x, lane.y, lane.width, lane.height, "Lane", lane.name)
        for node in all_nodes(process).values():
            width, height = node_size(node)
            add_shape(plane, node.id, node.x, node.y, width, height, node.kind, node.name)
        for flow in process.flows:
            add_edge(plane, flow, all_nodes(process))
        for node in process.nodes:
            for flow in node.child_flows:
                add_edge(plane, flow, all_nodes(process))
    for flow in message_flows:
        add_edge(plane, flow, all_by_id)


def fixture_xml(spec: FixtureSpec) -> str:
    root = ET.Element(
        q("bpmn", "definitions"),
        {
            "id": spec.definitions_id,
            "targetNamespace": "https://github.com/datakurre/bpmn-auto-layout/feedback-fixtures",
        },
    )
    for message_id, name in spec.messages:
        ET.SubElement(root, q("bpmn", "message"), {"id": message_id, "name": name})
    for data_store_id, name in spec.data_stores:
        ET.SubElement(root, q("bpmn", "dataStore"), {"id": data_store_id, "name": name})
    if spec.collaborations:
        collaboration_id, name, participants, message_flows = spec.collaborations
        collab = ET.SubElement(root, q("bpmn", "collaboration"), {"id": collaboration_id, "name": name})
        for participant in participants:
            ET.SubElement(collab, q("bpmn", "participant"), {"id": participant.id, "name": participant.name, "processRef": participant.process_ref})
        for flow in message_flows:
            add_bpmn_flow(collab, flow)
    for process in spec.processes:
        append_process(root, process)
    if spec.collaborations:
        collaboration_id, _name, participants, message_flows = spec.collaborations
        append_diagram(root, collaboration_id, collaboration_id, spec.processes, participants, message_flows)
    else:
        for process in spec.processes:
            append_diagram(root, process.id, process.id, (process,))
    ET.indent(root, space="  ")
    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" + ET.tostring(root, encoding="unicode") + "\n"


def fixture_sources() -> dict[str, str]:
    return {spec.filename: fixture_xml(spec) for spec in fixture_specs()}


def write_fixtures(output_dir: Path, force: bool) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for filename, xml in fixture_sources().items():
        target = output_dir / filename
        if target.exists() and not force:
            raise SystemExit(f"refusing to overwrite {target}; pass --force")
        target.write_text(xml, encoding="utf8")
        written.append(target)
    return written


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
    element_types = {element.get("id"): local_name(element.tag) for element in root.iter() if element.get("id") and element.tag.startswith("{" + NS["bpmn"] + "}")}
    element_counts: dict[str, int] = {}
    named_external_targets: set[str] = set()
    flow_endpoints: dict[str, tuple[str | None, str | None]] = {}
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

    shapes: list[dict[str, object]] = []
    labels: list[dict[str, float]] = []
    label_targets: set[str] = set()
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
                label["_plane"] = plane_id  # type: ignore[assignment]
                labels.append(label)
                label_targets.add(target_id)
            shapes.append({"id": shape.get("id", ""), "plane": plane_id, "bpmnElement": target_id, "type": element_types.get(target_id, ""), "bounds": bounds})
        for edge in plane.findall(q("bpmndi", "BPMNEdge")):
            points = [(float(point.get("x", "0")), float(point.get("y", "0"))) for point in edge.findall(q("di", "waypoint"))]
            label = label_bounds_from(edge)
            target_id = edge.get("bpmnElement", "")
            if label:
                label["_plane"] = plane_id  # type: ignore[assignment]
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
        for second in shapes[i + 1 :]:
            if first["plane"] != second["plane"]:
                continue
            second_bounds = second["bounds"]  # type: ignore[index]
            if first["type"] in CONTAINER_TYPES and contains(first_bounds, second_bounds):
                continue
            if second["type"] in CONTAINER_TYPES and contains(second_bounds, first_bounds):
                continue
            area = box_overlap(first_bounds, second_bounds)
            if area > 0:
                shape_overlaps += 1
                shape_overlap_area += area

    label_overlaps = 0
    for i, first in enumerate(labels):
        for second in labels[i + 1 :]:
            if first.get("_plane") != second.get("_plane"):
                continue
            if box_overlap(first, second) > 0:
                label_overlaps += 1

    edge_crossings = 0
    edge_shape_intersections = 0
    total_bends = 0
    total_manhattan = 0.0
    non_orthogonal_segments = 0
    for edge in edges:
        points = edge["points"]  # type: ignore[assignment]
        total_bends += max(0, len(points) - 2)
        endpoints = set(flow_endpoints.get(edge["bpmnElement"], (None, None)))  # type: ignore[arg-type]
        for a, b in zip(points, points[1:]):
            total_manhattan += abs(a[0] - b[0]) + abs(a[1] - b[1])
            if abs(a[0] - b[0]) >= 0.5 and abs(a[1] - b[1]) >= 0.5:
                non_orthogonal_segments += 1
            for shape in shapes:
                if shape["plane"] != edge["plane"]:
                    continue
                if shape["bpmnElement"] in endpoints or shape["type"] in CONTAINER_TYPES:
                    continue
                if segment_intersects_box(a, b, shape["bounds"]):  # type: ignore[arg-type]
                    edge_shape_intersections += 1
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

    grid_deviations: list[float] = []
    for shape in shapes:
        if shape["type"] in CONTAINER_TYPES:
            continue
        b = shape["bounds"]  # type: ignore[index]
        center_x = b["x"] + b["width"] / 2
        grid_deviations.append(abs(center_x - (75 + round((center_x - 75) / 150) * 150)))

    diagrams = len(list(root.iter(q("bpmndi", "BPMNDiagram"))))
    covered = sorted(named_external_targets.intersection(label_targets))
    missing = sorted(named_external_targets.difference(label_targets))
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
            "label_overlaps": label_overlaps,
            "edge_crossings": edge_crossings,
            "edge_shape_intersections": edge_shape_intersections,
            "total_bends": total_bends,
            "total_manhattan_length": round(total_manhattan, 2),
            "non_orthogonal_segments": non_orthogonal_segments,
            "grid_center_x_deviation_avg": round(sum(grid_deviations) / len(grid_deviations), 2) if grid_deviations else 0,
            "grid_center_x_deviation_max": round(max(grid_deviations), 2) if grid_deviations else 0,
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


def split_command(value: str) -> list[str]:
    parts = shlex.split(value)
    if not parts:
        raise SystemExit("command may not be empty")
    return parts


def render_report(args: argparse.Namespace) -> Path:
    report_root = Path(args.output_dir)
    report_root.mkdir(parents=True, exist_ok=True)
    workdir = Path(tempfile.mkdtemp(prefix="report-", dir=report_root))
    inputs = [Path(path) for path in args.inputs]
    if not inputs:
        generated_dir = workdir / "generated"
        inputs = write_fixtures(generated_dir, force=True)
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
        ("total bends", ("layout", "total_bends")),
        ("total Manhattan length", ("layout", "total_manhattan_length")),
        ("grid center-x avg deviation", ("layout", "grid_center_x_deviation_avg")),
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


def parse_ratings(values: list[str]) -> dict[str, int]:
    ratings: dict[str, int] = {}
    for value in values:
        if "=" not in value:
            raise SystemExit(f"rating must use name=value: {value}")
        name, raw_rating = value.split("=", 1)
        if name not in RATINGS:
            raise SystemExit(f"unknown rating {name!r}; expected one of {', '.join(RATINGS)}")
        rating = int(raw_rating)
        if rating < 1 or rating > 5:
            raise SystemExit(f"rating {name!r} must be 1..5")
        ratings[name] = rating
    return ratings


def feedback_payload(args: argparse.Namespace, choices: set[str], ratings: dict[str, int], comments: str) -> dict[str, object]:
    return {
        "schema": "bpmn-layout-feedback/v1",
        "created_at": _datetime.datetime.now(_datetime.UTC).replace(microsecond=0).isoformat(),
        "diagram": args.diagram,
        "report": args.report,
        "part": args.part,
        "choices": {choice: choice in choices for choice in CHOICES},
        "ratings": {name: ratings.get(name) for name in RATINGS},
        "comments": comments,
        "agent_ingest": {
            "ruleset": "docs/bpmn-layout-rules.json",
            "recommended_actions": [
                "compare choices and low ratings with report metrics",
                "update implementation-derived rules only after verifying TypeScript behavior",
                "rerun report on generated fixtures and affected user BPMN",
            ],
        },
    }


def default_feedback_output(args: argparse.Namespace) -> Path:
    root = Path(".bpmn-feedback") / "feedback"
    root.mkdir(parents=True, exist_ok=True)
    slug = Path(args.diagram or args.part or "feedback").stem or "feedback"
    stamp = _datetime.datetime.now(_datetime.UTC).strftime("%Y%m%dT%H%M%SZ")
    return root / f"{slug}-{stamp}.json"


def interactive_feedback(args: argparse.Namespace) -> tuple[set[str], dict[str, int], str]:
    selected: set[str] = set(args.choice or [])
    while True:
        print("\nToggle layout observations (comma-separated numbers), or press Enter when done:")
        for index, choice in enumerate(CHOICES, start=1):
            mark = "x" if choice in selected else " "
            print(f"  [{mark}] {index}. {choice}")
        answer = input("> ").strip()
        if not answer:
            break
        for token in answer.replace(",", " ").split():
            index = int(token)
            if index < 1 or index > len(CHOICES):
                raise SystemExit(f"choice index out of range: {index}")
            choice = CHOICES[index - 1]
            if choice in selected:
                selected.remove(choice)
            else:
                selected.add(choice)
    ratings = parse_ratings(args.rating or [])
    for name in RATINGS:
        if name in ratings:
            continue
        answer = input(f"Rate {name} (1=poor, 5=excellent, blank=skip): ").strip()
        if answer:
            rating = int(answer)
            if rating < 1 or rating > 5:
                raise SystemExit(f"rating {name!r} must be 1..5")
            ratings[name] = rating
    comments = args.comment or input("Comments (optional): ").strip()
    return selected, ratings, comments


def write_feedback(args: argparse.Namespace) -> Path:
    for choice in args.choice or []:
        if choice not in CHOICES:
            raise SystemExit(f"unknown choice {choice!r}; expected one of {', '.join(CHOICES)}")
    if args.non_interactive or not sys.stdin.isatty():
        choices = set(args.choice or [])
        ratings = parse_ratings(args.rating or [])
        comments = args.comment or ""
    else:
        choices, ratings, comments = interactive_feedback(args)
    output = Path(args.output) if args.output else default_feedback_output(args)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(feedback_payload(args, choices, ratings, comments), indent=2, sort_keys=True) + "\n", encoding="utf8")
    return output


def selftest() -> None:
    first = fixture_sources()
    second = fixture_sources()
    if first != second:
        raise SystemExit("fixture generation is not deterministic")
    aggregate: dict[str, int] = {}
    for filename, xml in first.items():
        scratch = Path(".bpmn-feedback") / "selftest"
        scratch.mkdir(parents=True, exist_ok=True)
        target = scratch / filename
        target.write_text(xml, encoding="utf8")
        metrics = collect_metrics(target)
        if metrics["layout"]["diagrams"] < 1:  # type: ignore[index]
            raise SystemExit(f"fixture lacks BPMN DI diagram: {filename}")
        for name, count in metrics["semantic"]["element_counts"].items():  # type: ignore[index]
            aggregate[name] = aggregate.get(name, 0) + count
    required = ["startEvent", "endEvent", "task", "userTask", "serviceTask", "exclusiveGateway", "parallelGateway", "subProcess", "boundaryEvent", "lane", "messageFlow", "dataObjectReference", "dataStoreReference"]
    missing = [name for name in required if aggregate.get(name, 0) == 0]
    if missing:
        raise SystemExit(f"generated fixtures are missing required element types: {', '.join(missing)}")
    print(f"selftest OK: {len(first)} deterministic fixtures cover {len(required)} required element types")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    generate = subparsers.add_parser("generate", help="write deterministic BPMN fixtures")
    generate.add_argument("--output", default="fixtures/bpmn-feedback", help="output directory (default: fixtures/bpmn-feedback)")
    generate.add_argument("--force", action="store_true", help="overwrite existing fixture files")

    report = subparsers.add_parser("report", help="layout, render, and metric BPMN files")
    report.add_argument("inputs", nargs="*", help="BPMN files; omitted means generated fixtures")
    report.add_argument("--output-dir", default=".bpmn-feedback/reports", help="workspace-local ephemeral report directory root")
    report.add_argument("--layout-command", default="bpmn-auto-layout", help="layout command, shell-style string")
    report.add_argument("--image-command", default="bpmn-to-image", help="image command, shell-style string")

    feedback = subparsers.add_parser("feedback", help="collect terminal feedback as JSON")
    feedback.add_argument("--output", help="feedback JSON path")
    feedback.add_argument("--diagram", help="BPMN path or diagram identifier")
    feedback.add_argument("--report", help="report HTML path")
    feedback.add_argument("--part", help="report part identifier")
    feedback.add_argument("--choice", action="append", default=[], help=f"checkbox choice; repeatable ({', '.join(CHOICES)})")
    feedback.add_argument("--rating", action="append", default=[], help=f"Likert rating name=value, 1..5; repeatable ({', '.join(RATINGS)})")
    feedback.add_argument("--comment", help="free-text comment")
    feedback.add_argument("--non-interactive", action="store_true", help="write from flags without prompts")

    subparsers.add_parser("selftest", help="validate deterministic fixtures and metrics without external dependencies")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "generate":
        paths = write_fixtures(Path(args.output), args.force)
        print("generated fixtures:")
        for path in paths:
            print(f"  {path}")
    elif args.command == "report":
        report_path = render_report(args)
        print(f"report: {report_path}")
    elif args.command == "feedback":
        output = write_feedback(args)
        print(f"feedback: {output}")
    elif args.command == "selftest":
        selftest()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
