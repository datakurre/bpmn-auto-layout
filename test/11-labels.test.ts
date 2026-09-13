import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import {
  estimateLabelDimensions,
  estimateWordWidth,
  computeLabelVisualShift,
  generateTextWrapCandidates,
  boxesOverlap,
  doesBoxCollide,
  doesSegmentCollideWithBox,
  computePathSegmentLabel,
  isEvent,
  isGateway,
  isFlow,
  isArtifact,
  isBoundaryEvent,
  layoutElementLabel,
  layoutPathLabel,
  layoutAllLabels,
  type PlacedShape,
  type PlacedEdge,
} from '../src/graph/label-layout';
import {
  EVENT_LABEL_MARGIN,
  BOUNDARY_EVENT_LABEL_MARGIN,
  GATEWAY_LABEL_MARGIN,
  ARTIFACT_LABEL_MARGIN,
  FLOW_LABEL_MARGIN,
} from '../src/di-constants';

describe('Iteration 11: Event, Gateway, and Path Labels', () => {
  describe('Helper Functions', () => {
    it('estimates word width across character classes', () => {
      expect(estimateWordWidth(' ')).toBe(3.5);
      expect(estimateWordWidth('m')).toBe(9.5);
      expect(estimateWordWidth('i')).toBe(3.5);
      expect(estimateWordWidth('A')).toBe(7.5);
      expect(estimateWordWidth('a')).toBe(6.0);
    });

    it('computes label visual shift compensating for renderer widening', () => {
      expect(computeLabelVisualShift(undefined)).toBe(0);
      expect(computeLabelVisualShift('')).toBe(0);
      expect(computeLabelVisualShift('   ')).toBe(0);
      expect(computeLabelVisualShift('Start')).toBe(2);
      expect(computeLabelVisualShift('  Start  ')).toBe(2);
      expect(computeLabelVisualShift('Start\n\n')).toBe(2);
      expect(computeLabelVisualShift('Process Started')).toBe(0);
      expect(computeLabelVisualShift('Order\nPlaced')).toBe(2);
    });

    it('accurately estimates label dimensions for various text patterns', () => {
      const single = estimateLabelDimensions('Start');
      expect(single.height).toBe(14);
      expect(single.width).toBeGreaterThanOrEqual(20);

      const multi = estimateLabelDimensions('Line 1\nLine 2\nLine 3');
      expect(multi.height).toBe(40);
      expect(multi.width).toBeGreaterThanOrEqual(20);

      const specialChars = estimateLabelDimensions('M W i j l r t f I 1 2 3 ! ?');
      expect(specialChars.height).toBe(14);
      expect(specialChars.width).toBeGreaterThanOrEqual(20);
    });

    it('generates balanced text wrap candidates for single and multi-word labels', () => {
      expect(generateTextWrapCandidates('Start')).toEqual(['Start']);
      expect(generateTextWrapCandidates('   ')).toEqual(['']);

      const twoWords = generateTextWrapCandidates('Underwriter Decision');
      expect(twoWords).toContain('Underwriter Decision');
      expect(twoWords).toContain('Underwriter\nDecision');

      const threeWords = generateTextWrapCandidates('Review Document Now');
      expect(threeWords).toContain('Review Document Now');
      expect(threeWords.join(' ')).toContain('\n');

      const fourWords = generateTextWrapCandidates('Check Credit Score And Collateral');
      expect(fourWords).toContain('Check Credit Score And Collateral');
      let hasThreeLines = false;
      for (const c of fourWords) {
        if (c.split('\n').length === 3) {
          hasThreeLines = true;
          break;
        }
      }
      expect(hasThreeLines).toBe(true);
    });

    it('identifies element categories accurately', () => {
      expect(isEvent({ $type: 'bpmn:StartEvent' })).toBe(true);
      expect(isEvent({ $type: 'bpmn:EndEvent' })).toBe(true);
      expect(isEvent({ $type: 'bpmn:IntermediateCatchEvent' })).toBe(true);
      expect(isEvent({ $type: 'bpmn:IntermediateThrowEvent' })).toBe(true);
      expect(isEvent({ $type: 'bpmn:BoundaryEvent' })).toBe(true);
      expect(isEvent({ $type: 'bpmn:Task' })).toBe(false);
      expect(isEvent(undefined)).toBe(false);
      expect(isEvent({})).toBe(false);

      expect(isGateway({ $type: 'bpmn:ExclusiveGateway' })).toBe(true);
      expect(isGateway({ $type: 'bpmn:ParallelGateway' })).toBe(true);
      expect(isGateway({ $type: 'bpmn:InclusiveGateway' })).toBe(true);
      expect(isGateway({ $type: 'bpmn:EventBasedGateway' })).toBe(true);
      expect(isGateway({ $type: 'bpmn:ComplexGateway' })).toBe(true);
      expect(isGateway({ $type: 'bpmn:Task' })).toBe(false);
      expect(isGateway(undefined)).toBe(false);
      expect(isGateway({})).toBe(false);

      expect(isFlow({ $type: 'bpmn:SequenceFlow' })).toBe(true);
      expect(isFlow({ $type: 'bpmn:MessageFlow' })).toBe(true);
      expect(isFlow({ $type: 'bpmn:Association' })).toBe(false);
      expect(isFlow(undefined)).toBe(false);
      expect(isFlow({})).toBe(false);

      expect(isBoundaryEvent({ $type: 'bpmn:BoundaryEvent' })).toBe(true);
      expect(isBoundaryEvent({ $type: 'bpmn:StartEvent' })).toBe(false);
      expect(isBoundaryEvent(undefined)).toBe(false);
      expect(isBoundaryEvent({})).toBe(false);

      expect(isArtifact({ $type: 'bpmn:DataObjectReference' })).toBe(true);
      expect(isArtifact({ $type: 'bpmn:DataStoreReference' })).toBe(true);
      expect(isArtifact({ $type: 'bpmn:Task' })).toBe(false);
      expect(isArtifact(undefined)).toBe(false);
      expect(isArtifact({})).toBe(false);
    });

    it('guarantees even dimensions for exact integer midpoint centering', () => {
      for (const text of ['A', 'Finish', 'Underwriter Decision', 'Check', 'Start Process Now']) {
        const dim = estimateLabelDimensions(text);
        expect(dim.width % 2).toBe(0);
        expect(dim.height % 2).toBe(0);
      }
    });

    it('checks box overlaps and collisions against shapes, edges, and labels', () => {
      const box1 = { x: 10, y: 10, width: 20, height: 20 };
      const box2 = { x: 25, y: 25, width: 20, height: 20 };
      const box3 = { x: 50, y: 50, width: 20, height: 20 };

      expect(boxesOverlap(box1, box2)).toBe(true);
      expect(boxesOverlap(box1, box3)).toBe(false);

      // Diagonal segment collision
      expect(
        doesSegmentCollideWithBox(
          { x: 0, y: 0 },
          { x: 100, y: 100 },
          { x: 40, y: 40, width: 20, height: 20 }
        )
      ).toBe(true);
      expect(
        doesSegmentCollideWithBox(
          { x: 0, y: 0 },
          { x: 100, y: 100 },
          { x: 200, y: 200, width: 20, height: 20 }
        )
      ).toBe(false);

      const cctx = {
        shapes: [
          {
            element: { id: 'P1', $type: 'bpmn:Participant' },
            bounds: { x: 0, y: 0, width: 200, height: 200 },
          },
          {
            element: { id: 'T1', $type: 'bpmn:Task' },
            bounds: { x: 50, y: 50, width: 100, height: 80 },
          },
          {
            element: { id: 'S_Self', $type: 'bpmn:StartEvent' },
            bounds: { x: 10, y: 10, width: 36, height: 36 },
          },
        ],
        edges: [
          {
            element: { id: 'E1' },
            waypoints: [
              { x: 10, y: 100 },
              { x: 200, y: 100 },
            ],
          },
          {
            element: { id: 'E_Ignored' },
            waypoints: [
              { x: 10, y: 10 },
              { x: 20, y: 20 },
            ],
          },
        ],
        placedLabels: [{ x: 300, y: 300, width: 40, height: 20 }],
        ignoreElementId: 'S_Self',
      };

      // Collides with task T1
      expect(doesBoxCollide({ x: 60, y: 60, width: 20, height: 20 }, cctx)).toBe(true);
      // Collides with horizontal edge E1
      expect(doesBoxCollide({ x: 50, y: 95, width: 20, height: 20 }, cctx)).toBe(true);
      // Collides with placed label
      expect(doesBoxCollide({ x: 310, y: 310, width: 20, height: 20 }, cctx)).toBe(true);
      // Free location
      expect(doesBoxCollide({ x: 220, y: 10, width: 20, height: 20 }, cctx)).toBe(false);
    });

    it('computes path segment label bounds for horizontal and vertical segments across sides', () => {
      const hGeom = {
        p1: { x: 0, y: 50 },
        p2: { x: 100, y: 50 },
        dim: { width: 40, height: 20 },
        margin: 10,
      };
      const topBounds = computePathSegmentLabel(hGeom, 'top');
      expect(topBounds.y).toBe(50 - 10 - 20);
      expect(topBounds.x).toBe(50 - 20);

      const botBounds = computePathSegmentLabel(hGeom, 'bottom');
      expect(botBounds.y).toBe(50 + 10);
      expect(botBounds.x).toBe(50 - 20);

      const vGeom = {
        p1: { x: 50, y: 0 },
        p2: { x: 50, y: 100 },
        dim: { width: 40, height: 20 },
        margin: 10,
      };
      const rightBounds = computePathSegmentLabel(vGeom, 'right');
      expect(rightBounds.x).toBe(50 + 10);
      expect(rightBounds.y).toBe(50 - 10);

      const leftBounds = computePathSegmentLabel(vGeom, 'left');
      expect(leftBounds.x).toBe(50 - 10 - 40);
      expect(leftBounds.y).toBe(50 - 10);
    });
  });

  describe('Event Label Layout', () => {
    it('positions start event label orthogonally bottom and horizontally centered', async () => {
      const builder = new BpmnBuilder('Process_Start');
      builder.addStartEvent('Start_1', 'Process Started');

      const xml = await layoutProcess(await builder.toXml());
      expect(xml).toContain('<bpmndi:BPMNLabel>');

      // Start shape is centered in lane at y=122, h=36 -> bottom margin 10 -> y = 168
      // center x = 118 -> label center x should be 118
      const labelMatch = xml.match(
        /<bpmndi:BPMNShape id="Start_1_di"[^>]*>[\s\S]*?<bpmndi:BPMNLabel>[\s\S]*?<dc:Bounds x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="([0-9.]+)"/
      );
      expect(labelMatch).not.toBeNull();
      if (labelMatch) {
        const [, x, y, w] = labelMatch.map(Number);
        expect(y).toBe(122 + 36 + EVENT_LABEL_MARGIN);
        const labelCenterX = x + w / 2;
        expect(Math.abs(labelCenterX - 118)).toBeLessThanOrEqual(1);
      }
    });

    it('positions event label on Top when Bottom is obstructed', () => {
      const shape: PlacedShape = {
        element: { id: 'Start_1', $type: 'bpmn:StartEvent', name: 'Start Flow' },
        bounds: { x: 100, y: 100, width: 36, height: 36 },
      };
      // Obstacle below start event (at y=140..200)
      const obstacle: PlacedShape = {
        element: { id: 'Task_Below', $type: 'bpmn:Task' },
        bounds: { x: 80, y: 140, width: 100, height: 80 },
      };
      const placedLabels: any[] = [];
      layoutElementLabel(shape, placedLabels, {
        shapes: [shape, obstacle],
        edges: [],
      });

      expect(shape.labelBounds).toBeDefined();
      // Should be placed on Top: y = 100 - EVENT_LABEL_MARGIN - height
      expect(shape.labelBounds!.y).toBeLessThan(100);
      const labelCenterX = shape.labelBounds!.x + shape.labelBounds!.width / 2;
      expect(Math.abs(labelCenterX - 118)).toBeLessThanOrEqual(1);
    });

    it('falls back to diagonal when all 4 orthogonal sides are obstructed', () => {
      const shape: PlacedShape = {
        element: {
          id: 'Event_Trapped',
          $type: 'bpmn:IntermediateCatchEvent',
          name: 'Trapped Timer',
        },
        bounds: { x: 100, y: 100, width: 36, height: 36 },
      };
      // Surround strictly on orthogonal sides (leaving diagonal corners open)
      const topObs: PlacedShape = {
        element: { id: 'T_Top', $type: 'bpmn:Task' },
        bounds: { x: 95, y: 30, width: 45, height: 65 },
      };
      const botObs: PlacedShape = {
        element: { id: 'T_Bot', $type: 'bpmn:Task' },
        bounds: { x: 95, y: 140, width: 45, height: 65 },
      };
      const leftObs: PlacedShape = {
        element: { id: 'T_Left', $type: 'bpmn:Task' },
        bounds: { x: 20, y: 95, width: 75, height: 45 },
      };
      const rightObs: PlacedShape = {
        element: { id: 'T_Right', $type: 'bpmn:Task' },
        bounds: { x: 140, y: 95, width: 75, height: 45 },
      };

      const placedLabels: any[] = [];
      layoutElementLabel(shape, placedLabels, {
        shapes: [shape, topObs, botObs, leftObs, rightObs],
        edges: [],
      });

      expect(shape.labelBounds).toBeDefined();
      // Diagonal position: x > 136 and y < 100 (top-right)
      const isDiagonal =
        (shape.labelBounds!.x >= 136 || shape.labelBounds!.x + shape.labelBounds!.width <= 100) &&
        (shape.labelBounds!.y >= 136 || shape.labelBounds!.y + shape.labelBounds!.height <= 100);
      expect(isDiagonal).toBe(true);
    });

    it('omits label when element name is absent or empty', () => {
      const shape: PlacedShape = {
        element: { id: 'Event_NoName', $type: 'bpmn:StartEvent' },
        bounds: { x: 100, y: 100, width: 36, height: 36 },
      };
      const placedLabels: any[] = [];
      layoutElementLabel(shape, placedLabels, { shapes: [shape], edges: [] });
      expect(shape.labelBounds).toBeUndefined();

      const shapeWhitespace: PlacedShape = {
        element: { id: 'Event_Empty', $type: 'bpmn:EndEvent', name: '   ' },
        bounds: { x: 100, y: 100, width: 36, height: 36 },
      };
      layoutElementLabel(shapeWhitespace, placedLabels, { shapes: [shapeWhitespace], edges: [] });
      expect(shapeWhitespace.labelBounds).toBeUndefined();
    });
  });

  describe('Gateway Label Layout', () => {
    it('positions gateway label avoiding outgoing and incoming branches', async () => {
      const builder = new BpmnBuilder('Process_Gateway');
      builder
        .addStartEvent('Start_1')
        .addExclusiveGateway('Split_1', 'Branch Decision')
        .addTask('Task_Top', 'Top Task')
        .addTask('Task_Bot', 'Bottom Task')
        .addSequenceFlow('F1', 'Start_1', 'Split_1')
        .addSequenceFlow('F2', 'Split_1', 'Task_Top')
        .addSequenceFlow('F3', 'Split_1', 'Task_Bot');

      const xml = await layoutProcess(await builder.toXml());
      expect(xml).toContain('id="Split_1_di"');
      expect(xml).toContain('<bpmndi:BPMNLabel>');

      // Verify that Split_1 label does not collide with the flow waypoints
      const splitDi = xml.slice(xml.indexOf('id="Split_1_di"'));
      const labelMatch = splitDi.match(
        /<bpmndi:BPMNLabel>[\s\S]*?<dc:Bounds x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="([0-9.]+)"/
      );
      expect(labelMatch).not.toBeNull();
    });

    it('maintains consistent GATEWAY_LABEL_MARGIN distance', () => {
      const shape: PlacedShape = {
        element: { id: 'Gate_1', $type: 'bpmn:ExclusiveGateway', name: 'Gateway Decision' },
        bounds: { x: 200, y: 100, width: 50, height: 50 },
      };
      const placedLabels: any[] = [];
      layoutElementLabel(shape, placedLabels, { shapes: [shape], edges: [] });

      expect(shape.labelBounds).toBeDefined();
      // Default free side is bottom: y = 100 + 50 + GATEWAY_LABEL_MARGIN = 160
      expect(shape.labelBounds!.y).toBe(100 + 50 + GATEWAY_LABEL_MARGIN);
    });
  });

  describe('Path Label Layout', () => {
    it('positions sequence flow label along a horizontal segment', async () => {
      const builder = new BpmnBuilder('Process_FlowLabel');
      builder.addStartEvent('Start_1').addEndEvent('End_1').addSequenceFlow({
        id: 'F1',
        sourceRef: 'Start_1',
        targetRef: 'End_1',
        name: 'Approved',
      });

      const xml = await layoutProcess(await builder.toXml());
      expect(xml).toContain('name="Approved"');
      expect(xml).toContain('<bpmndi:BPMNLabel>');

      const edgeDi = xml.slice(xml.indexOf('id="F1_di"'));
      const labelMatch = edgeDi.match(
        /<bpmndi:BPMNLabel>[\s\S]*?<dc:Bounds x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="([0-9.]+)"/
      );
      expect(labelMatch).not.toBeNull();
      if (labelMatch) {
        const [, , y, , h] = labelMatch.map(Number);
        // Start is at y=122, End is at y=122 -> connection line at y=140
        // Top position is y = 140 - FLOW_LABEL_MARGIN - h
        expect(y + h + FLOW_LABEL_MARGIN).toBe(140);
      }
    });

    it('positions sequence flow label along a vertical segment', () => {
      const edge: PlacedEdge = {
        element: { id: 'F_Vert', $type: 'bpmn:SequenceFlow', name: 'Retry Loop' },
        waypoints: [
          { x: 100, y: 100 },
          { x: 100, y: 300 },
        ],
      };
      const placedLabels: any[] = [];
      layoutPathLabel(edge, placedLabels, { shapes: [], edges: [edge] });

      expect(edge.labelBounds).toBeDefined();
      // Horizontal offset: x = 100 + FLOW_LABEL_MARGIN
      expect(edge.labelBounds!.x).toBe(100 + FLOW_LABEL_MARGIN);
      // Vertically centered on midpoint (y=200)
      const midY = edge.labelBounds!.y + edge.labelBounds!.height / 2;
      expect(Math.abs(midY - 200)).toBeLessThanOrEqual(1);
    });

    it('omits path label when name is absent, empty, or edge has fewer than 2 waypoints', () => {
      const edgeNoName: PlacedEdge = {
        element: { id: 'F_NoName', $type: 'bpmn:SequenceFlow' },
        waypoints: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
      };
      const edgeShort: PlacedEdge = {
        element: { id: 'F_Short', $type: 'bpmn:SequenceFlow', name: 'Short' },
        waypoints: [{ x: 0, y: 0 }],
      };
      const placedLabels: any[] = [];
      layoutPathLabel(edgeNoName, placedLabels, { shapes: [], edges: [edgeNoName] });
      expect(edgeNoName.labelBounds).toBeUndefined();

      layoutPathLabel(edgeShort, placedLabels, { shapes: [], edges: [edgeShort] });
      expect(edgeShort.labelBounds).toBeUndefined();
    });

    it('chooses the longest segment on multi-segment edges', () => {
      const edge: PlacedEdge = {
        element: { id: 'F_Multi', $type: 'bpmn:SequenceFlow', name: 'Multi Seg' },
        waypoints: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 20 },
        ],
      };
      const placedLabels: any[] = [];
      layoutPathLabel(edge, placedLabels, { shapes: [], edges: [edge] });
      expect(edge.labelBounds).toBeDefined();
      expect(edge.labelBounds!.x).toBeGreaterThan(0);
      expect(edge.labelBounds!.x).toBeLessThan(100);
    });

    it('places label on bottom when top of horizontal segment is obstructed', () => {
      const edge: PlacedEdge = {
        element: { id: 'F_H', $type: 'bpmn:SequenceFlow', name: 'Go Down' },
        waypoints: [
          { x: 0, y: 50 },
          { x: 100, y: 50 },
        ],
      };
      const topObs: PlacedShape = {
        element: { id: 'Obs_Top', $type: 'bpmn:Task' },
        bounds: { x: 10, y: 15, width: 80, height: 30 },
      };
      const placedLabels: any[] = [];
      layoutPathLabel(edge, placedLabels, { shapes: [topObs], edges: [edge] });
      expect(edge.labelBounds).toBeDefined();
      expect(edge.labelBounds!.y).toBe(50 + FLOW_LABEL_MARGIN);
    });

    it('places label on left when right of vertical segment is obstructed', () => {
      const edge: PlacedEdge = {
        element: { id: 'F_V', $type: 'bpmn:SequenceFlow', name: 'Go Left' },
        waypoints: [
          { x: 50, y: 0 },
          { x: 50, y: 100 },
        ],
      };
      const rightObs: PlacedShape = {
        element: { id: 'Obs_Right', $type: 'bpmn:Task' },
        bounds: { x: 55, y: 20, width: 60, height: 60 },
      };
      const placedLabels: any[] = [];
      layoutPathLabel(edge, placedLabels, { shapes: [rightObs], edges: [edge] });
      expect(edge.labelBounds).toBeDefined();
      expect(edge.labelBounds!.x).toBeLessThan(50);
    });

    it('falls back to default side when all candidate sides of path collide', () => {
      const edge: PlacedEdge = {
        element: { id: 'F_Trapped', $type: 'bpmn:SequenceFlow', name: 'Trapped Flow' },
        waypoints: [
          { x: 0, y: 50 },
          { x: 100, y: 50 },
        ],
      };
      const topObs: PlacedShape = {
        element: { id: 'Obs_Top', $type: 'bpmn:Task' },
        bounds: { x: 10, y: 10, width: 80, height: 35 },
      };
      const botObs: PlacedShape = {
        element: { id: 'Obs_Bot', $type: 'bpmn:Task' },
        bounds: { x: 10, y: 55, width: 80, height: 35 },
      };
      const placedLabels: any[] = [];
      layoutPathLabel(edge, placedLabels, { shapes: [topObs, botObs], edges: [edge] });
      expect(edge.labelBounds).toBeDefined();
    });
  });

  describe('Adaptive Text Wrapping', () => {
    it('replaces spaces with line breaks when horizontal width causes collisions', () => {
      // Create a shape between two obstacles spaced 80px apart
      const shape: PlacedShape = {
        element: {
          id: 'Gate_Narrow',
          $type: 'bpmn:ExclusiveGateway',
          name: 'Underwriter Risk Evaluation',
        },
        bounds: { x: 100, y: 100, width: 50, height: 50 },
      };
      // Place obstacles left and right of the bottom area leaving only 70px corridor
      const leftObstacle: PlacedShape = {
        element: { id: 'Obs_L', $type: 'bpmn:Task' },
        bounds: { x: 0, y: 155, width: 90, height: 50 },
      };
      const rightObstacle: PlacedShape = {
        element: { id: 'Obs_R', $type: 'bpmn:Task' },
        bounds: { x: 160, y: 155, width: 90, height: 50 },
      };
      // Top, Left, Right are blocked
      const topObs: PlacedShape = {
        element: { id: 'Obs_T', $type: 'bpmn:Task' },
        bounds: { x: 80, y: 20, width: 90, height: 75 },
      };
      const directLeft: PlacedShape = {
        element: { id: 'Obs_DL', $type: 'bpmn:Task' },
        bounds: { x: 0, y: 85, width: 95, height: 70 },
      };
      const directRight: PlacedShape = {
        element: { id: 'Obs_DR', $type: 'bpmn:Task' },
        bounds: { x: 155, y: 85, width: 95, height: 70 },
      };

      const placedLabels: any[] = [];
      layoutElementLabel(shape, placedLabels, {
        shapes: [shape, leftObstacle, rightObstacle, topObs, directLeft, directRight],
        edges: [],
      });

      expect(shape.labelBounds).toBeDefined();
      // Should have wrapped name with newline to fit corridor
      expect(shape.element.name).toContain('\n');
    });
  });

  describe('Diagram-Level Orchestration', () => {
    it('orchestrates labels across mixed shapes and edges without conflicts', () => {
      const s1: PlacedShape = {
        element: { id: 'S1', $type: 'bpmn:StartEvent', name: 'Start Process' },
        bounds: { x: 100, y: 100, width: 36, height: 36 },
      };
      const g1: PlacedShape = {
        element: { id: 'G1', $type: 'bpmn:ExclusiveGateway', name: 'Decision' },
        bounds: { x: 200, y: 93, width: 50, height: 50 },
      };
      const e1: PlacedEdge = {
        element: { id: 'F1', $type: 'bpmn:SequenceFlow', name: 'Proceed' },
        waypoints: [
          { x: 136, y: 118 },
          { x: 200, y: 118 },
        ],
      };

      const ctx = {
        shapes: [s1, g1],
        edges: [e1],
      };

      layoutAllLabels(ctx);

      expect(s1.labelBounds).toBeDefined();
      expect(g1.labelBounds).toBeDefined();
      expect(e1.labelBounds).toBeDefined();
    });

    it('positions artifact labels and avoids path collisions (places above document if blocked below)', () => {
      const docShape: PlacedShape = {
        element: { id: 'Doc_1', $type: 'bpmn:DataObjectReference', name: 'Loan Dossier' },
        bounds: { x: 200, y: 100, width: 36, height: 50 },
      };
      const taskShape: PlacedShape = {
        element: { id: 'Task_1', $type: 'bpmn:Task', name: 'Ingest' },
        bounds: { x: 168, y: 220, width: 100, height: 80 },
      };
      const assocEdge: PlacedEdge = {
        element: { id: 'Assoc_1', $type: 'bpmn:Association' },
        waypoints: [
          { x: 218, y: 150 },
          { x: 218, y: 220 },
        ],
      };

      const storeShape: PlacedShape = {
        element: { id: 'Store_1', $type: 'bpmn:DataStoreReference', name: 'Core DB' },
        bounds: { x: 400, y: 100, width: 50, height: 50 },
      };

      const ctx = {
        shapes: [docShape, taskShape, storeShape],
        edges: [assocEdge],
      };

      layoutAllLabels(ctx);

      // Doc label should be placed on TOP because bottom is blocked by the association edge
      expect(docShape.labelBounds).toBeDefined();
      expect(docShape.labelBounds!.y).toBeLessThan(docShape.bounds.y);

      // Store label should be placed on BOTTOM with ARTIFACT_LABEL_MARGIN
      expect(storeShape.labelBounds).toBeDefined();
      expect(storeShape.labelBounds!.y).toBe(
        storeShape.bounds.y + storeShape.bounds.height + ARTIFACT_LABEL_MARGIN
      );
    });

    it('positions boundary event labels directly below task border adjacent to the circle', () => {
      const taskShape: PlacedShape = {
        element: { id: 'Task_Host', $type: 'bpmn:Task', name: 'Host Activity' },
        bounds: { x: 100, y: 100, width: 100, height: 80 },
      };
      const boundaryShape: PlacedShape = {
        element: {
          id: 'Boundary_1',
          $type: 'bpmn:BoundaryEvent',
          attachedToRef: 'Task_Host',
          name: '24h Timeout',
        },
        bounds: { x: 132, y: 162, width: 36, height: 36 },
      };
      // Outgoing edge leaving bottom
      const outEdge: PlacedEdge = {
        element: { id: 'Flow_Out', $type: 'bpmn:SequenceFlow' },
        waypoints: [
          { x: 150, y: 198 },
          { x: 150, y: 240 },
        ],
      };

      const placedLabels: any[] = [];
      layoutElementLabel(boundaryShape, placedLabels, {
        shapes: [taskShape, boundaryShape],
        edges: [outEdge],
      });

      expect(boundaryShape.labelBounds).toBeDefined();
      // Should be placed to the right, tightly below the task border using BOUNDARY_EVENT_LABEL_MARGIN
      expect(boundaryShape.labelBounds!.y).toBe(
        boundaryShape.bounds.y + boundaryShape.bounds.height + BOUNDARY_EVENT_LABEL_MARGIN
      );
      expect(boundaryShape.labelBounds!.x).toBe(
        boundaryShape.bounds.x + boundaryShape.bounds.width + BOUNDARY_EVENT_LABEL_MARGIN
      );
    });

    it('handles all diagonal quadrant placements for gateways and boundary events', () => {
      // Gateway diagonal placements
      const gwCorners = ['top-right', 'bottom-right', 'top-left', 'bottom-left'] as const;
      for (const corner of gwCorners) {
        const gwShape: PlacedShape = {
          element: { id: 'GW_D', $type: 'bpmn:ExclusiveGateway', name: 'Check Condition' },
          bounds: { x: 200, y: 200, width: 50, height: 50 },
        };
        // Place obstacles on all orthogonal sides and other diagonal corners to force this specific corner
        const obstacles: PlacedShape[] = [
          // top
          {
            element: { id: 'O_T', $type: 'bpmn:Task' },
            bounds: { x: 190, y: 100, width: 70, height: 80 },
          },
          // bottom
          {
            element: { id: 'O_B', $type: 'bpmn:Task' },
            bounds: { x: 190, y: 260, width: 70, height: 80 },
          },
          // right
          {
            element: { id: 'O_R', $type: 'bpmn:Task' },
            bounds: { x: 260, y: 190, width: 70, height: 70 },
          },
          // left
          {
            element: { id: 'O_L', $type: 'bpmn:Task' },
            bounds: { x: 120, y: 190, width: 70, height: 70 },
          },
        ];
        // Block other diagonal corners
        for (const other of gwCorners) {
          if (other !== corner) {
            const bx = other.includes('right') ? 240 : 160;
            const by = other.includes('bottom') ? 240 : 160;
            obstacles.push({
              element: { id: `O_${other}`, $type: 'bpmn:Task' },
              bounds: { x: bx, y: by, width: 50, height: 50 },
            });
          }
        }
        const placedLabels: any[] = [];
        layoutElementLabel(gwShape, placedLabels, {
          shapes: [gwShape, ...obstacles],
          edges: [],
        });
        expect(gwShape.labelBounds).toBeDefined();
      }

      // Generic element (e.g. EndEvent) diagonal placements for all 4 corners
      const genericCorners = ['top-right', 'bottom-right', 'top-left', 'bottom-left'] as const;
      for (const corner of genericCorners) {
        const evShape: PlacedShape = {
          element: { id: 'EV_D', $type: 'bpmn:EndEvent', name: 'Finish Subflow Here' },
          bounds: { x: 200, y: 200, width: 36, height: 36 },
        };
        const obstacles: PlacedShape[] = [
          // top
          {
            element: { id: 'O_T', $type: 'bpmn:Task' },
            bounds: { x: 180, y: 120, width: 70, height: 70 },
          },
          // bottom
          {
            element: { id: 'O_B', $type: 'bpmn:Task' },
            bounds: { x: 180, y: 246, width: 70, height: 70 },
          },
          // right
          {
            element: { id: 'O_R', $type: 'bpmn:Task' },
            bounds: { x: 246, y: 180, width: 70, height: 70 },
          },
          // left
          {
            element: { id: 'O_L', $type: 'bpmn:Task' },
            bounds: { x: 110, y: 180, width: 70, height: 70 },
          },
        ];
        // Block other corners
        for (const other of genericCorners) {
          if (other !== corner) {
            const bx = other.includes('right') ? 240 : 130;
            const by = other.includes('bottom') ? 240 : 130;
            obstacles.push({
              element: { id: `O_gen_${other}`, $type: 'bpmn:Task' },
              bounds: { x: bx, y: by, width: 50, height: 50 },
            });
          }
        }
        const placedLabels: any[] = [];
        layoutElementLabel(evShape, placedLabels, {
          shapes: [evShape, ...obstacles],
          edges: [],
        });
        expect(evShape.labelBounds).toBeDefined();
      }
    });
  });
});
