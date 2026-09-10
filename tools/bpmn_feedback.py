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
from dataclasses import dataclass, field
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

EVENT_DEFINITION_TAGS = {
    "message": "messageEventDefinition",
    "timer": "timerEventDefinition",
    "error": "errorEventDefinition",
    "signal": "signalEventDefinition",
    "escalation": "escalationEventDefinition",
    "conditional": "conditionalEventDefinition",
    "compensate": "compensateEventDefinition",
    "terminate": "terminateEventDefinition",
    "cancel": "cancelEventDefinition",
    "link": "linkEventDefinition",
    "multiple": "multipleEventDefinition",
    "parallelMultiple": "parallelMultipleEventDefinition",
}

CONTAINER_TYPES = {"lane", "participant", "subProcess"}
ROUTE_UNIT = 50
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
    extensions: tuple[tuple[str, dict[str, str]], ...] = ()
    io_inputs: tuple[tuple[str, str], ...] = ()
    io_outputs: tuple[tuple[str, str], ...] = ()
    io_input_associations: tuple[tuple[str, str], ...] = ()
    io_output_associations: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class Flow:
    id: str
    source: str
    target: str
    name: str = ""
    kind: str = "sequenceFlow"
    attrs: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Artifact:
    id: str
    kind: str
    name: str = ""
    x: int = 0
    y: int = 0
    width: int = 100
    height: int = 60
    attrs: dict[str, str] = field(default_factory=dict)


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
    attrs: dict[str, str] = field(default_factory=dict)
    extensions: tuple[tuple[str, dict[str, str]], ...] = ()
    artifacts: tuple[Artifact, ...] = ()


@dataclass(frozen=True)
class FixtureSpec:
    filename: str
    definitions_id: str
    processes: tuple[ProcessSpec, ...]
    messages: tuple[tuple[str, str], ...] = ()
    signals: tuple[tuple[str, str], ...] = ()
    escalations: tuple[tuple[str, str], ...] = ()
    data_objects: tuple[str, ...] = ()
    data_stores: tuple[tuple[str, str], ...] = ()
    collaborations: tuple[str, str, tuple[Participant, ...], tuple[Flow, ...]] | None = None
    vendor_extensions: bool = False


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


def extension_elements(parent: ET.Element, extensions: tuple[tuple[str, dict[str, str]], ...]) -> None:
    if not extensions:
        return
    container = ET.SubElement(parent, q("bpmn", "extensionElements"))
    for tag, attrs in extensions:
        ET.SubElement(container, q("vendor", tag), attrs)


def io_specification(node_element: ET.Element, node: Node) -> None:
    if not (node.io_inputs or node.io_outputs or node.io_input_associations or node.io_output_associations):
        return
    specification = ET.SubElement(node_element, q("bpmn", "ioSpecification"), {"id": f"{node.id}_ioSpecification"})
    for element_id, name in node.io_inputs:
        ET.SubElement(specification, q("bpmn", "dataInput"), {"id": element_id, "name": name})
    for element_id, name in node.io_outputs:
        ET.SubElement(specification, q("bpmn", "dataOutput"), {"id": element_id, "name": name})
    input_set = ET.SubElement(specification, q("bpmn", "inputSet"), {"id": f"{node.id}_inputSet"})
    for element_id, _name in node.io_inputs:
        add_text(input_set, "dataInputRefs", element_id)
    output_set = ET.SubElement(specification, q("bpmn", "outputSet"), {"id": f"{node.id}_outputSet"})
    for element_id, _name in node.io_outputs:
        add_text(output_set, "dataOutputRefs", element_id)
    for source, target in node.io_input_associations:
        association = ET.SubElement(node_element, q("bpmn", "dataInputAssociation"))
        add_text(association, "sourceRef", source)
        add_text(association, "targetRef", target)
    for source, target in node.io_output_associations:
        association = ET.SubElement(node_element, q("bpmn", "dataOutputAssociation"))
        add_text(association, "sourceRef", source)
        add_text(association, "targetRef", target)


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
    io_specification(element, node)
    extension_elements(element, node.extensions)
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
    attrs.update(flow.attrs)
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


def add_artifact(parent: ET.Element, artifact: Artifact) -> None:
    attrs = {"id": artifact.id}
    if artifact.name and artifact.kind != "TextAnnotation" and artifact.kind != "Group":
        attrs["name"] = artifact.name
    attrs.update(artifact.attrs)
    element = ET.SubElement(parent, q("bpmn", bpmn_tag(artifact.kind)), attrs)
    if artifact.kind == "TextAnnotation" and artifact.name:
        add_text(element, "text", artifact.name)


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

    coverage = ProcessSpec(
        id="Process_ActivitiesGatewaysCoverage",
        name="Activities and gateways coverage",
        nodes=(
            Node("C7_Start", "StartEvent", "Start", 60, 180),
            Node("C7_User", "UserTask", "User task", 150, 158),
            Node("C7_Service", "ServiceTask", "Service task", 300, 158),
            Node("C7_Send", "SendTask", "Send task", 450, 158),
            Node("C7_Receive", "ReceiveTask", "Receive task", 600, 158),
            Node("C7_Manual", "ManualTask", "Manual task", 750, 158),
            Node("C7_Script", "ScriptTask", "Script task", 900, 158),
            Node("C7_BusinessRule", "BusinessRuleTask", "Business rule", 1050, 158),
            Node("C7_Inclusive", "InclusiveGateway", "Any approval", 1200, 173),
            Node("C7_Complex", "ComplexGateway", "Complex merge", 1350, 173),
            Node("C7_EventBased", "EventBasedGateway", "Wait for event", 1500, 173),
            Node("C7_Call", "CallActivity", "Call invoice process", 1650, 158, attrs={"calledElement": "InvoiceProcess"}),
            Node("C7_End", "EndEvent", "Complete", 1800, 180),
        ),
        flows=tuple(
            Flow(f"C7_Flow_{index}", source, target)
            for index, (source, target) in enumerate(
                (
                    ("C7_Start", "C7_User"),
                    ("C7_User", "C7_Service"),
                    ("C7_Service", "C7_Send"),
                    ("C7_Send", "C7_Receive"),
                    ("C7_Receive", "C7_Manual"),
                    ("C7_Manual", "C7_Script"),
                    ("C7_Script", "C7_BusinessRule"),
                    ("C7_BusinessRule", "C7_Inclusive"),
                    ("C7_Inclusive", "C7_Complex"),
                    ("C7_Complex", "C7_EventBased"),
                    ("C7_EventBased", "C7_Call"),
                    ("C7_Call", "C7_End"),
                ),
                start=1,
            )
        ),
        is_executable=True,
    )

    events = ProcessSpec(
        id="Process_EventDefinitions",
        name="BPMN event definitions",
        nodes=(
            Node("Events_Start", "StartEvent", "Message start", 60, 180, event_definitions=(EventDefinition("message", {"messageRef": "Message_Event"}),)),
            Node("Events_Timer", "IntermediateCatchEvent", "Timer wait", 180, 180, event_definitions=(EventDefinition("timer"),)),
            Node("Events_Signal", "IntermediateCatchEvent", "Signal wait", 300, 180, event_definitions=(EventDefinition("signal", {"signalRef": "Signal_Event"}),)),
            Node("Events_Error", "IntermediateCatchEvent", "Error wait", 420, 180, event_definitions=(EventDefinition("error"),)),
            Node("Events_Conditional", "IntermediateCatchEvent", "Condition wait", 540, 180, event_definitions=(EventDefinition("conditional"),)),
            Node("Events_Link", "IntermediateThrowEvent", "Continue", 660, 180, event_definitions=(EventDefinition("link", {"name": "continue"}),)),
            Node("Events_Escalation", "IntermediateThrowEvent", "Escalate", 780, 180, event_definitions=(EventDefinition("escalation", {"escalationRef": "Escalation_Event"}),)),
            Node("Events_Compensate", "IntermediateThrowEvent", "Compensate", 900, 180, event_definitions=(EventDefinition("compensate"),)),
            Node("Events_Cancel", "IntermediateThrowEvent", "Cancel", 1020, 180, event_definitions=(EventDefinition("cancel"),)),
            Node("Events_End", "EndEvent", "Terminated", 1140, 180, event_definitions=(EventDefinition("terminate"),)),
        ),
        flows=tuple(
            Flow(f"Events_Flow_{index}", f"Events_{left}", f"Events_{right}")
            for index, (left, right) in enumerate(
                (
                    ("Start", "Timer"),
                    ("Timer", "Signal"),
                    ("Signal", "Error"),
                    ("Error", "Conditional"),
                    ("Conditional", "Link"),
                    ("Link", "Escalation"),
                    ("Escalation", "Compensate"),
                    ("Compensate", "Cancel"),
                    ("Cancel", "End"),
                ),
                start=1,
            )
        ),
    )

    boundary = ProcessSpec(
        id="Process_BoundaryAndSubprocesses",
        name="Boundary events and embedded subprocess",
        nodes=(
            Node("Boundary_Start", "StartEvent", "Request", 60, 180),
            Node("Boundary_Task", "ServiceTask", "Process request", 180, 158),
            Node(
                "Boundary_InterruptingTimer",
                "BoundaryEvent",
                "Timeout",
                250,
                220,
                attrs={"attachedToRef": "Boundary_Task"},
                event_definitions=(EventDefinition("timer"),),
            ),
            Node(
                "Boundary_NonInterruptingMessage",
                "BoundaryEvent",
                "Message override",
                290,
                220,
                attrs={"attachedToRef": "Boundary_Task", "cancelActivity": "false"},
                event_definitions=(EventDefinition("message", {"messageRef": "Message_Override"}),),
            ),
            Node(
                "Boundary_SubProcess",
                "SubProcess",
                "Fulfil request",
                420,
                120,
                width=300,
                height=180,
                children=(
                    Node("Boundary_SubStart", "StartEvent", "Inside", 450, 202),
                    Node("Boundary_SubTask", "UserTask", "Handle", 525, 180),
                    Node("Boundary_SubEnd", "EndEvent", "Handled", 650, 202),
                ),
                child_flows=(
                    Flow("Boundary_SubFlow_Start", "Boundary_SubStart", "Boundary_SubTask"),
                    Flow("Boundary_SubFlow_End", "Boundary_SubTask", "Boundary_SubEnd"),
                ),
            ),
            Node("Boundary_End", "EndEvent", "Done", 780, 180),
            Node("Boundary_TimeoutTask", "ScriptTask", "Recover timeout", 420, 380),
            Node("Boundary_TimeoutEnd", "EndEvent", "Timed out", 580, 402),
            Node("Boundary_MessageTask", "UserTask", "Review override", 420, 520),
            Node("Boundary_MessageEnd", "EndEvent", "Override handled", 580, 542),
        ),
        flows=(
            Flow("Boundary_Flow_Start", "Boundary_Start", "Boundary_Task"),
            Flow("Boundary_Flow_Task", "Boundary_Task", "Boundary_SubProcess"),
            Flow("Boundary_Flow_End", "Boundary_SubProcess", "Boundary_End"),
            Flow("Boundary_Flow_Timeout", "Boundary_InterruptingTimer", "Boundary_TimeoutTask"),
            Flow("Boundary_Flow_Timeout_End", "Boundary_TimeoutTask", "Boundary_TimeoutEnd"),
            Flow("Boundary_Flow_Message", "Boundary_NonInterruptingMessage", "Boundary_MessageTask"),
            Flow("Boundary_Flow_Message_End", "Boundary_MessageTask", "Boundary_MessageEnd"),
        ),
        is_executable=True,
    )

    artifacts = ProcessSpec(
        id="Process_DataArtifacts",
        name="Data and BPMN artifacts",
        nodes=(
            Node("Artifact_Start", "StartEvent", "Start", 60, 180),
            Node(
                "Artifact_Task",
                "ServiceTask",
                "Transform data",
                220,
                158,
                io_inputs=(("Artifact_Task_Input", "Input"),),
                io_outputs=(("Artifact_Task_Output", "Output"),),
                io_input_associations=(("Artifact_DataInput", "Artifact_Task_Input"),),
                io_output_associations=(("Artifact_Task_Output", "Artifact_DataOutput"),),
            ),
            Node("Artifact_End", "EndEvent", "Done", 500, 180),
        ),
        flows=(
            Flow("Artifact_Flow_Start", "Artifact_Start", "Artifact_Task"),
            Flow("Artifact_Flow_End", "Artifact_Task", "Artifact_End"),
            Flow("Artifact_Association_In", "Artifact_DataInput", "Artifact_Task", kind="association"),
            Flow("Artifact_Association_Out", "Artifact_Task", "Artifact_Annotation", kind="association"),
        ),
        artifacts=(
            Artifact("Artifact_DataInput", "DataObjectReference", "Input document", 180, 300, 50, 64, {"dataObjectRef": "Artifact_InputObject"}),
            Artifact("Artifact_DataOutput", "DataStoreReference", "Output store", 430, 300, 50, 64, {"dataStoreRef": "Artifact_OutputStore"}),
            Artifact("Artifact_Annotation", "TextAnnotation", "Important transformation note", 600, 130, 180, 70),
            Artifact("Artifact_Group", "Group", "Data handling", 140, 260, 600, 150),
        ),
    )

    vendor_extensions = ProcessSpec(
        id="Process_VendorExtensions",
        name="Vendor extensions",
        nodes=(
            Node("Vendor_Start", "StartEvent", "Start", 60, 180),
            Node(
                "Vendor_User",
                "UserTask",
                "Approve request",
                180,
                158,
                attrs={
                    q("vendor", "assignee"): "demo",
                    q("vendor", "candidateGroups"): "approvers",
                    q("vendor", "formKey"): "embedded:app:approval.html",
                    q("vendor", "asyncBefore"): "true",
                },
                extensions=(
                    ("formData", {"businessKey": "requestId"}),
                    ("taskListener", {"event": "create", q("vendor", "class"): "com.example.AuditListener"}),
                ),
            ),
            Node(
                "Vendor_Service",
                "ServiceTask",
                "Invoke worker",
                360,
                158,
                attrs={
                    q("vendor", "type"): "external",
                    q("vendor", "topic"): "invoice",
                    q("vendor", "asyncAfter"): "true",
                    q("vendor", "failedJobRetryTimeCycle"): "R3/PT10M",
                },
                extensions=(
                    ("executionListener", {q("vendor", "event"): "start", q("vendor", "expression"): "${audit()}"}),
                    ("inputOutput", {q("vendor", "source"): "requestId", q("vendor", "target"): "workerRequest"}),
                ),
            ),
            Node("Vendor_End", "EndEvent", "Complete", 540, 180),
        ),
        flows=(
            Flow("Vendor_Flow_Start", "Vendor_Start", "Vendor_User"),
            Flow("Vendor_Flow_Service", "Vendor_User", "Vendor_Service"),
            Flow("Vendor_Flow_End", "Vendor_Service", "Vendor_End"),
        ),
        is_executable=True,
        attrs={q("vendor", "historyTimeToLive"): "180"},
        extensions=(("properties", {"source": "fixture"}),),
    )

    stress_routing = ProcessSpec(
        id="Process_StressRouting",
        name="Stress: dense routing and loops",
        nodes=(
            Node("Stress_Start", "StartEvent", "Very long request intake label", 60, 250),
            Node("Stress_Prepare", "UserTask", "Prepare and validate a request with a long descriptive label", 150, 228),
            Node("Stress_Decide", "ExclusiveGateway", "Validation passed?", 310, 243),
            Node("Stress_Reject", "ServiceTask", "Reject and notify requester", 470, 70),
            Node("Stress_Review", "UserTask", "Manual review with additional checks", 470, 228),
            Node("Stress_Repair", "ScriptTask", "Repair invalid data and retry", 470, 430),
            Node("Stress_Parallel", "ParallelGateway", "Run all follow-up work", 650, 243),
            Node("Stress_Notify", "SendTask", "Send a long notification message", 810, 70),
            Node("Stress_Audit", "ServiceTask", "Write audit record", 810, 228),
            Node("Stress_Archive", "ManualTask", "Archive the completed request", 810, 430),
            Node("Stress_Merge", "InclusiveGateway", "All applicable work complete?", 990, 243),
            Node("Stress_End", "EndEvent", "Successfully completed with a long final label", 1150, 250),
        ),
        flows=(
            Flow("Stress_Flow_Start", "Stress_Start", "Stress_Prepare"),
            Flow("Stress_Flow_Decide", "Stress_Prepare", "Stress_Decide"),
            Flow("Stress_Flow_Reject", "Stress_Decide", "Stress_Reject", "reject"),
            Flow("Stress_Flow_Review", "Stress_Decide", "Stress_Review", "review"),
            Flow("Stress_Flow_Repair", "Stress_Decide", "Stress_Repair", "repair"),
            Flow("Stress_Flow_Review_Decide", "Stress_Review", "Stress_Decide", "needs another pass"),
            Flow("Stress_Flow_Repair_Review", "Stress_Repair", "Stress_Review", "retry review"),
            Flow("Stress_Flow_Reject_End", "Stress_Reject", "Stress_End"),
            Flow("Stress_Flow_Review_Parallel", "Stress_Review", "Stress_Parallel"),
            Flow("Stress_Flow_Parallel_Notify", "Stress_Parallel", "Stress_Notify"),
            Flow("Stress_Flow_Parallel_Audit", "Stress_Parallel", "Stress_Audit"),
            Flow("Stress_Flow_Parallel_Archive", "Stress_Parallel", "Stress_Archive"),
            Flow("Stress_Flow_Notify_Merge", "Stress_Notify", "Stress_Merge"),
            Flow("Stress_Flow_Audit_Merge", "Stress_Audit", "Stress_Merge"),
            Flow("Stress_Flow_Archive_Merge", "Stress_Archive", "Stress_Merge"),
            Flow("Stress_Flow_Merge_End", "Stress_Merge", "Stress_End"),
        ),
    )

    return [
        FixtureSpec("basic-events-tasks.bpmn", "Definitions_BasicEventsTasks", (basic,), messages=(("Message_Receipt", "Receipt"),)),
        FixtureSpec("boundary-and-subprocesses.bpmn", "Definitions_BoundaryAndSubprocesses", (boundary,), messages=(("Message_Override", "Override"),)),
        FixtureSpec(
            "activities-gateways.bpmn",
            "Definitions_ActivitiesGatewaysCoverage",
            (coverage,),
            vendor_extensions=True,
        ),
        FixtureSpec("extensions.bpmn", "Definitions_VendorExtensions", (vendor_extensions,), vendor_extensions=True),
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
        FixtureSpec(
            "data-artifacts.bpmn",
            "Definitions_DataArtifacts",
            (artifacts,),
            data_stores=(("Artifact_OutputStore", "Output store"),),
        ),
        FixtureSpec(
            "event-definitions.bpmn",
            "Definitions_EventDefinitions",
            (events,),
            messages=(("Message_Event", "Event"),),
            signals=(("Signal_Event", "Signal"),),
            escalations=(("Escalation_Event", "Escalation"),),
        ),
        FixtureSpec("gateways-branches-loops.bpmn", "Definitions_GatewaysBranchesLoops", (branches,)),
        FixtureSpec("stress-dense-routing.bpmn", "Definitions_StressRouting", (stress_routing,)),
        FixtureSpec(
            "subprocess-boundary-data-lanes.bpmn",
            "Definitions_SubprocessBoundaryDataLanes",
            (subprocess,),
            data_stores=(("DataStore_Inventory", "Inventory"),),
        ),
    ]


def append_process(root: ET.Element, process: ProcessSpec) -> None:
    attrs = {"id": process.id, "isExecutable": "true" if process.is_executable else "false"}
    if process.name:
        attrs["name"] = process.name
    attrs.update(process.attrs)
    proc = ET.SubElement(root, q("bpmn", "process"), attrs)
    extension_elements(proc, process.extensions)
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
    for artifact in process.artifacts:
        if artifact.kind == "DataObjectReference":
            ET.SubElement(proc, q("bpmn", "dataObject"), {"id": artifact.attrs.get("dataObjectRef", f"{artifact.id}_Object")})
        add_artifact(proc, artifact)
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
        all_by_id.update(
            {
                artifact.id: Node(artifact.id, artifact.kind, artifact.name, artifact.x, artifact.y, artifact.width, artifact.height)
                for artifact in process.artifacts
            }
        )
        for lane in process.lanes:
            add_shape(plane, lane.id, lane.x, lane.y, lane.width, lane.height, "Lane", lane.name)
        for node in all_nodes(process).values():
            width, height = node_size(node)
            add_shape(plane, node.id, node.x, node.y, width, height, node.kind, node.name)
        for artifact in process.artifacts:
            add_shape(plane, artifact.id, artifact.x, artifact.y, artifact.width, artifact.height, artifact.kind, artifact.name)
        for flow in process.flows:
            if flow.kind != "association":
                add_edge(plane, flow, all_nodes(process))
        for node in process.nodes:
            for flow in node.child_flows:
                add_edge(plane, flow, all_nodes(process))
        for flow in process.flows:
            if flow.kind == "association":
                add_edge(plane, flow, all_by_id)
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
    for signal_id, name in spec.signals:
        ET.SubElement(root, q("bpmn", "signal"), {"id": signal_id, "name": name})
    for escalation_id, name in spec.escalations:
        ET.SubElement(root, q("bpmn", "escalation"), {"id": escalation_id, "name": name})
    for data_object_id in spec.data_objects:
        ET.SubElement(root, q("bpmn", "dataObject"), {"id": data_object_id})
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
                if any(element_parents.get(endpoint) == container_id for endpoint in endpoints if endpoint):
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
        ("total bends", ("layout", "total_bends")),
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
def selftest(layout_command: list[str] | None = None) -> None:
    first = persisted_fixtures()
    second = persisted_fixtures()
    if first != second:
        raise SystemExit("persisted fixture set changed while being read")
    aggregate: dict[str, int] = {}
    engine_ran = False
    for filename, xml in first.items():
        scratch = Path(".bpmn-feedback") / "selftest"
        scratch.mkdir(parents=True, exist_ok=True)
        target = scratch / filename
        target.write_text(xml, encoding="utf8")
        if layout_command and run_command_if_available(layout_command + [str(target)], f"layout {filename}"):
            engine_ran = True
        metrics = collect_metrics(target)
        if metrics["layout"]["diagrams"] < 1:  # type: ignore[index]
            raise SystemExit(f"fixture lacks BPMN DI diagram: {filename}")
        for name, count in metrics["semantic"]["element_counts"].items():  # type: ignore[index]
            aggregate[name] = aggregate.get(name, 0) + count
    if layout_command and not engine_ran:
        print(
            f"selftest warning: layout command {shlex.join(layout_command)!r} not found on PATH; "
            "validating persisted DI as-is instead of freshly generated layout output",
        )
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
    suffix = "with fresh layout-engine output" if engine_ran else "structure-only (layout command unavailable)"
    print(f"selftest OK: {len(first)} persisted fixtures cover {len(required)} required element types ({suffix})")


def latest_report(output_dir: str) -> Path:
    root = Path(output_dir)
    reports = [path for path in root.glob("report-*/index.html") if path.is_file()]
    if not reports:
        raise SystemExit(f"no reports found under {root}")
    return max(reports, key=lambda path: path.stat().st_mtime)


def check_report(args: argparse.Namespace) -> None:
    report = resolve_report_reference(args.report, args.output_dir) if args.report else latest_report(args.output_dir)
    if report.is_dir():
        report /= "index.html"
    metrics_path = report.parent / "metrics.json"
    if not metrics_path.is_file():
        raise SystemExit(f"report metrics do not exist: {metrics_path}")
    document = json.loads(metrics_path.read_text(encoding="utf8"))
    failures: list[str] = []
    for entry in document.get("entries", []):
        title = entry.get("title", entry.get("source", "diagram"))
        layout = entry["transformed_metrics"]["layout"]
        for metric in (
            "edge_crossings",
            "edge_shape_intersections",
            "edge_container_intersections",
            "invalid_edge_attachments",
            "non_orthogonal_segments",
            "label_overlaps",
            "invalid_label_bounds",
            "shape_overlaps",
            "label_shape_intersections",
            "label_edge_intersections",
            "excess_turns",
        ):
            value = layout[metric]
            if value > 0:
                failures.append(f"{title}: {metric}={value}")
        for detail in layout.get("excess_turn_details", []):
            failures.append(f"{title}: {detail['edge']} has {detail['excess_turns']} excess turn(s)")
        for detail in layout.get("edge_crossing_details", []):
            failures.append(f"{title}: crossing {detail['first']} x {detail['second']}")
        for detail in layout.get("edge_shape_intersection_details", []):
            failures.append(f"{title}: {detail['edge']} intersects {detail['shape']}")
        for detail in layout.get("edge_container_intersection_details", []):
            failures.append(f"{title}: {detail['edge']} intersects container {detail['container']}")
        for detail in layout.get("invalid_edge_attachment_details", []):
            failures.append(f"{title}: {detail['edge']} has invalid {detail['end']} attachment")
        for detail in layout.get("label_shape_intersection_details", []):
            failures.append(f"{title}: label {detail['label']} intersects {detail['shape']}")
        for detail in layout.get("label_edge_intersection_details", []):
            failures.append(f"{title}: label {detail['label']} intersects edge {detail['edge']}")
        missing = layout["named_label_coverage"]["missing"]
        if missing > 0:
            failures.append(f"{title}: missing_named_labels={missing}")
    if failures:
        raise SystemExit("layout checks failed:\n" + "\n".join(f"  {failure}" for failure in failures))
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
        help="validate persisted fixtures and, when the layout command is available, re-verify them against current layout output",
    )
    selftest_parser.add_argument(
        "--layout-command",
        default="bpmn-auto-layout",
        help="layout command, shell-style string; skipped with a warning if not found on PATH",
    )
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
        selftest(split_command(args.layout_command))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
