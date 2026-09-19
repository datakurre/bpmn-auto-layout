import { describe, it, expect } from 'vitest';
import {
  alignCollaborationPaths,
  alignIntraProcessBranches,
  alignVerticallyStackedPaths,
  unifyCollaborationPoolWidths,
} from '../src/hierarchy/path-alignment';
import type { ScopeLayoutResult } from '../src/hierarchy/subprocess-layout';

describe('path-alignment unit tests', () => {
  describe('unifyCollaborationPoolWidths', () => {
    it('returns early when allPools is empty or has 1 pool', () => {
      const ctx: any = {
        allPools: [],
        allShapes: [],
        allShapesMap: new Map(),
      };
      unifyCollaborationPoolWidths(ctx);
      expect(ctx.allPools).toEqual([]);

      const singlePoolCtx: any = {
        allPools: [{ element: { id: 'P1' }, bounds: { x: 100, y: 100, width: 500, height: 200 } }],
        allShapes: [],
        allShapesMap: new Map([['P1', { x: 100, y: 100, width: 500, height: 200 }]]),
      };
      unifyCollaborationPoolWidths(singlePoolCtx);
      expect(singlePoolCtx.allPools[0].bounds.width).toBe(500);
    });

    it('unifies widths for multiple pools and their lanes', () => {
      const pool1 = { element: { id: 'P1' }, bounds: { x: 100, y: 80, width: 500, height: 200 } };
      const pool2 = { element: { id: 'P2' }, bounds: { x: 100, y: 320, width: 600, height: 200 } };
      const lane1 = { element: { id: 'L1' }, bounds: { x: 130, y: 80, width: 470, height: 200 } };
      const shape1 = { element: { id: 'S1' }, bounds: { x: 550, y: 120, width: 100, height: 80 } };

      const shapesMap = new Map();
      shapesMap.set('P1', pool1.bounds);
      shapesMap.set('P2', pool2.bounds);
      shapesMap.set('L1', lane1.bounds);
      shapesMap.set('S1', shape1.bounds);

      const ctx: any = {
        allPools: [pool1, pool2],
        allShapes: [shape1],
        allShapesMap: shapesMap,
        allLanes: [lane1],
      };

      unifyCollaborationPoolWidths(ctx);
      // maxShapeRight for P1 is 550 + 100 = 650. 650 - 100 + 60 = 610 > 600.
      expect(pool1.bounds.width).toBe(610);
      expect(pool2.bounds.width).toBe(610);
      expect(lane1.bounds.width).toBe(610 - 30);
    });

    it('handles pools without shapes, undefined allLanes, and lanes without matching pool', () => {
      const pool1 = { element: { id: 'P1' }, bounds: { x: 100, y: 80, width: 500, height: 200 } };
      const pool2 = { element: { id: 'P2' }, bounds: { x: 100, y: 320, width: 600, height: 200 } };
      const shapesMap = new Map([
        ['P1', pool1.bounds],
        ['P2', pool2.bounds],
      ]);

      const ctxNoLanes: any = {
        allPools: [pool1, pool2],
        allShapes: [],
        allShapesMap: shapesMap,
      };
      unifyCollaborationPoolWidths(ctxNoLanes);
      expect(pool1.bounds.width).toBe(600);

      const orphanLane = {
        element: { id: 'OL' },
        bounds: { x: 130, y: 9999, width: 400, height: 200 },
      };
      const ctxOrphanLane: any = {
        allPools: [pool1, pool2],
        allShapes: [],
        allShapesMap: shapesMap,
        allLanes: [orphanLane],
      };
      unifyCollaborationPoolWidths(ctxOrphanLane);
      expect(orphanLane.bounds.width).toBe(400);
    });
  });

  describe('alignCollaborationPaths', () => {
    it('returns early when messageFlows is empty', () => {
      const ctx: any = {
        definitions: { rootElements: [] },
        collaboration: { messageFlows: [] },
        allPools: [],
        allShapes: [],
        allShapesMap: new Map(),
      };
      alignCollaborationPaths(ctx);
      expect(ctx.allShapes).toEqual([]);
    });

    it('returns early when pairs is empty (no inter-pool flows)', () => {
      const ctx: any = {
        definitions: {
          rootElements: [
            {
              $type: 'bpmn:Process',
              id: 'Proc1',
              flowElements: [{ id: 'N1', $type: 'bpmn:Task' }],
            },
          ],
        },
        collaboration: {
          messageFlows: [{ sourceRef: 'N1', targetRef: 'N1' }],
        },
        allPools: [],
        allShapes: [],
        allShapesMap: new Map(),
      };
      alignCollaborationPaths(ctx);
      expect(ctx.allShapes).toEqual([]);
    });

    it('skips message flows referencing missing bounds or unknown process', () => {
      const ctx: any = {
        definitions: {
          rootElements: [
            {
              $type: 'bpmn:Process',
              id: 'Proc1',
              flowElements: [{ id: 'A', $type: 'bpmn:Task' }],
            },
            {
              $type: 'bpmn:Process',
              id: 'Proc2',
              flowElements: [{ id: 'B', $type: 'bpmn:Task' }],
            },
          ],
        },
        collaboration: {
          messageFlows: [
            { sourceRef: 'A', targetRef: 'B' },
            { sourceRef: 'Missing1', targetRef: 'Missing2' },
          ],
        },
        allShapesMap: new Map([
          // Only B has bounds, A is missing
          ['B', { x: 200, y: 100, width: 100, height: 80 }],
        ]),
        allShapes: [],
        allEdges: [],
      };
      alignCollaborationPaths(ctx);
      expect(ctx.allShapesMap.get('B')?.x).toBe(200);
    });

    it('handles subprocesses, feedback edges, and missing ref ids in process graph', () => {
      const subProcess = {
        $type: 'bpmn:SubProcess',
        id: 'Sub1',
        flowElements: [{ id: 'SubTask', $type: 'bpmn:Task' }],
      };
      const proc1 = {
        $type: 'bpmn:Process',
        id: 'Proc1',
        flowElements: [
          { id: 'T1', $type: 'bpmn:Task' },
          subProcess,
          {
            $type: 'bpmn:SequenceFlow',
            id: 'F_Feedback',
            sourceRef: 'T1',
            targetRef: 'T1',
          },
          {
            $type: 'bpmn:SequenceFlow',
            id: 'F_Broken',
            sourceRef: null,
            targetRef: null,
          },
        ],
      };
      const proc2 = {
        $type: 'bpmn:Process',
        id: 'Proc2',
        flowElements: [{ id: 'T2', $type: 'bpmn:Task' }],
      };

      const shapesMap = new Map([
        ['T1', { x: 100, y: 100, width: 100, height: 80 }],
        ['T2', { x: 100, y: 300, width: 100, height: 80 }],
      ]);

      const ctx: any = {
        definitions: { rootElements: [proc1, proc2] },
        collaboration: {
          messageFlows: [{ sourceRef: 'T1', targetRef: 'T2' }],
        },
        allShapesMap: shapesMap,
        allShapes: [],
        allEdges: [],
      };

      // T1 center: 150, T2 center: 150 -> already aligned (diff = 0)
      alignCollaborationPaths(ctx);
      expect(shapesMap.get('T1')?.x).toBe(100);
      expect(shapesMap.get('T2')?.x).toBe(100);
    });

    it('shifts target or sender forward to align centers and reroutes edges', () => {
      const proc1 = {
        $type: 'bpmn:Process',
        id: 'Proc1',
        flowElements: [
          { id: 'A1', $type: 'bpmn:Task' },
          { id: 'A2', $type: 'bpmn:Task' },
          { $type: 'bpmn:SequenceFlow', id: 'FA', sourceRef: 'A1', targetRef: 'A2' },
        ],
      };
      const proc2 = {
        $type: 'bpmn:Process',
        id: 'Proc2',
        flowElements: [
          { id: 'B1', $type: 'bpmn:Task' },
          { id: 'B2', $type: 'bpmn:Task' },
          { $type: 'bpmn:SequenceFlow', id: 'FB', sourceRef: 'B1', targetRef: 'B2' },
        ],
      };

      // A1 (x: 300..400, center 350) -> B1 (x: 100..200, center 150)
      // B1 needs to shift by 350 - 150 = 200
      const shapesMap = new Map([
        ['A1', { x: 300, y: 100, width: 100, height: 80 }],
        ['A2', { x: 500, y: 100, width: 100, height: 80 }],
        ['B1', { x: 100, y: 300, width: 100, height: 80 }],
        ['B2', { x: 250, y: 300, width: 100, height: 80 }],
      ]);

      const edgeB = {
        element: { id: 'FB', sourceRef: 'B1', targetRef: 'B2' },
        waypoints: [
          { x: 200, y: 340 },
          { x: 250, y: 340 },
        ],
      };

      const ctx: any = {
        definitions: { rootElements: [proc1, proc2] },
        collaboration: {
          messageFlows: [{ sourceRef: 'A1', targetRef: 'B1' }],
        },
        allShapesMap: shapesMap,
        allShapes: [],
        allEdges: [edgeB],
      };

      alignCollaborationPaths(ctx);
      expect(shapesMap.get('B1')?.x).toBe(300);
      expect(shapesMap.get('B2')?.x).toBe(450);
      // Edge FB re-routed
      expect(edgeB.waypoints[0].x).toBe(400);
    });

    it('shifts sender forward when tgtCenter > srcCenter', () => {
      const proc1 = {
        $type: 'bpmn:Process',
        id: 'Proc1',
        flowElements: [{ id: 'S1', $type: 'bpmn:Task' }],
      };
      const proc2 = {
        $type: 'bpmn:Process',
        id: 'Proc2',
        flowElements: [{ id: 'R1', $type: 'bpmn:Task' }],
      };

      // S1 (x: 100, center 150) sends to R1 (x: 300, center 350)
      const shapesMap = new Map([
        ['S1', { x: 100, y: 100, width: 100, height: 80 }],
        ['R1', { x: 300, y: 300, width: 100, height: 80 }],
      ]);

      const ctx: any = {
        definitions: { rootElements: [proc1, proc2] },
        collaboration: {
          messageFlows: [{ sourceRef: 'S1', targetRef: 'R1' }],
        },
        allShapesMap: shapesMap,
        allShapes: [],
        allEdges: [],
      };

      alignCollaborationPaths(ctx);
      expect(shapesMap.get('S1')?.x).toBe(300);
    });

    it('handles definitions without rootElements, processes without flowElements, and missing shape bounds', () => {
      const ctxNoRoot: any = {
        definitions: {},
        collaboration: { messageFlows: [{ sourceRef: 'S', targetRef: 'T' }] },
        allShapesMap: new Map(),
        allShapes: [],
        allEdges: [],
      };
      alignCollaborationPaths(ctxNoRoot);

      const pEmpty = { id: 'PEmpty', $type: 'bpmn:Process' };
      const p1 = {
        id: 'P1',
        $type: 'bpmn:Process',
        flowElements: [
          { id: 'S1', $type: 'bpmn:Task' },
          { id: 'S2', $type: 'bpmn:Task' },
          { $type: 'bpmn:SequenceFlow', id: 'FS', sourceRef: 'S1', targetRef: 'S2' },
        ],
      };
      const p2 = {
        id: 'P2',
        $type: 'bpmn:Process',
        flowElements: [{ id: 'R1', $type: 'bpmn:Task' }],
      };

      const shapesMap = new Map([
        ['S1', { x: 100, y: 100, width: 100, height: 80 }],
        ['R1', { x: 300, y: 300, width: 100, height: 80 }],
      ]);

      const ctx: any = {
        definitions: { rootElements: [pEmpty, p1, p2] },
        collaboration: {
          messageFlows: [{ sourceRef: 'S1', targetRef: 'R1' }],
        },
        allShapesMap: shapesMap,
        allShapes: [],
        allEdges: [],
      };
      alignCollaborationPaths(ctx);
      expect(shapesMap.get('S1')?.x).toBe(300);
    });
  });

  describe('alignIntraProcessBranches', () => {
    it('returns false when no candidate gateway or no multiple outgoing flows', () => {
      const process = {
        flowElements: [
          { id: 'T1', $type: 'bpmn:Task' },
          { id: 'T2', $type: 'bpmn:Task' },
          { $type: 'bpmn:SequenceFlow', id: 'F1', sourceRef: 'T1', targetRef: 'T2' },
        ],
      };
      const result: ScopeLayoutResult = {
        width: 300,
        height: 100,
        minX: 100,
        minY: 100,
        shapes: [
          { element: { id: 'T1' }, bounds: { x: 100, y: 100, width: 100, height: 80 } },
          { element: { id: 'T2' }, bounds: { x: 250, y: 100, width: 100, height: 80 } },
        ],
        edges: [],
      };

      const res = alignIntraProcessBranches({ process, result });
      expect(res).toBe(false);
    });

    it('returns false when joinFlow has invalid target or no corridor obstacle', () => {
      const gw = { id: 'GW1', $type: 'bpmn:ExclusiveGateway' };
      const join = { id: 'Join1', $type: 'bpmn:ExclusiveGateway' };
      const t1 = { id: 'T1', $type: 'bpmn:Task' };
      const process = {
        flowElements: [
          gw,
          join,
          t1,
          // Broken flow without targetRef
          { $type: 'bpmn:SequenceFlow', id: 'F_Broken', sourceRef: 'GW1', targetRef: null },
          { $type: 'bpmn:SequenceFlow', id: 'F1', sourceRef: 'GW1', targetRef: 'Join1' },
          { $type: 'bpmn:SequenceFlow', id: 'F2', sourceRef: 'GW1', targetRef: 'T1' },
        ],
      };
      const result: ScopeLayoutResult = {
        width: 400,
        height: 200,
        minX: 100,
        minY: 100,
        shapes: [
          { element: gw, bounds: { x: 100, y: 100, width: 50, height: 50 } },
          { element: join, bounds: { x: 300, y: 200, width: 50, height: 50 } },
          { element: t1, bounds: { x: 200, y: 100, width: 100, height: 80 } },
        ],
        edges: [],
      };

      // Join1 only has 1 incoming flow (incCount < 2), so joinFlow is not recognized
      const res = alignIntraProcessBranches({ process, result });
      expect(res).toBe(false);
    });

    it('returns false when target column is behind or shift exceeds slack', () => {
      const gw = { id: 'GW1', $type: 'bpmn:ExclusiveGateway' };
      const join = { id: 'Join1', $type: 'bpmn:ExclusiveGateway' };
      const obs = { id: 'Obs', $type: 'bpmn:Task' };
      const fail = { id: 'Fail', $type: 'bpmn:Task' };
      const other = { id: 'Other', $type: 'bpmn:Task' };
      const process = {
        flowElements: [
          gw,
          join,
          obs,
          fail,
          other,
          { $type: 'bpmn:SequenceFlow', id: 'F_Join', sourceRef: 'GW1', targetRef: 'Join1' },
          { $type: 'bpmn:SequenceFlow', id: 'F_Join2', sourceRef: 'Obs', targetRef: 'Join1' },
          { $type: 'bpmn:SequenceFlow', id: 'F_Fail', sourceRef: 'GW1', targetRef: 'Fail' },
        ],
      };
      // Obs is at x: 100..200, y: 160..240 directly under GW1 (x: 100..150, y: 100..150)
      // Join1 is at x: 250
      // No parallel node exists with x >= 200 and < 250, so targetX is undefined
      const result: ScopeLayoutResult = {
        width: 400,
        height: 300,
        minX: 100,
        minY: 100,
        shapes: [
          { element: gw, bounds: { x: 100, y: 100, width: 50, height: 50 } },
          { element: join, bounds: { x: 250, y: 200, width: 50, height: 50 } },
          { element: obs, bounds: { x: 100, y: 160, width: 100, height: 80 } },
          { element: fail, bounds: { x: 180, y: 100, width: 100, height: 80 } },
        ],
        edges: [],
      };

      const res = alignIntraProcessBranches({ process, result });
      expect(res).toBe(false);
    });

    it('returns false when shift exceeds join node slack boundary', () => {
      const gw = { id: 'GW1', $type: 'bpmn:ExclusiveGateway' };
      const join = { id: 'Join1', $type: 'bpmn:ExclusiveGateway' };
      const obs = { id: 'Obs', $type: 'bpmn:Task' };
      const nextCol = { id: 'NextCol', $type: 'bpmn:Task' };
      const fail = { id: 'Fail', $type: 'bpmn:Task' };
      const process = {
        flowElements: [
          gw,
          join,
          obs,
          nextCol,
          fail,
          { $type: 'bpmn:SequenceFlow', id: 'F_Join', sourceRef: 'GW1', targetRef: 'Join1' },
          { $type: 'bpmn:SequenceFlow', id: 'F_Join2', sourceRef: 'Obs', targetRef: 'Join1' },
          { $type: 'bpmn:SequenceFlow', id: 'F_Fail', sourceRef: 'GW1', targetRef: 'Fail' },
        ],
      };
      // targetX will be 240, but Join1 is at 250.
      // gBounds.x (100) + deltaX (140) + width (50) + 60 = 350 > 250 -> exceeds slack!
      const result: ScopeLayoutResult = {
        width: 400,
        height: 300,
        minX: 100,
        minY: 100,
        shapes: [
          { element: gw, bounds: { x: 100, y: 100, width: 50, height: 50 } },
          { element: join, bounds: { x: 250, y: 200, width: 50, height: 50 } },
          { element: obs, bounds: { x: 100, y: 160, width: 100, height: 80 } },
          { element: nextCol, bounds: { x: 240, y: 160, width: 50, height: 50 } },
          { element: fail, bounds: { x: 180, y: 100, width: 100, height: 80 } },
        ],
        edges: [],
      };

      const res = alignIntraProcessBranches({ process, result });
      expect(res).toBe(false);
    });

    it('successfully shifts candidate gateway and its non-join subtree', () => {
      const gw = { id: 'GW1', $type: 'bpmn:ExclusiveGateway' };
      const join = { id: 'Join1', $type: 'bpmn:ExclusiveGateway' };
      const obs = { id: 'Obs', $type: 'bpmn:Task' };
      const col1 = { id: 'Col1', $type: 'bpmn:Task' };
      const col2 = { id: 'Col2', $type: 'bpmn:Task' };
      const noBoundsNode = { id: 'NoBounds', $type: 'bpmn:Task' };
      const fail = { id: 'Fail', $type: 'bpmn:Task' };
      const failEnd = { id: 'FailEnd', $type: 'bpmn:EndEvent' };

      const flowJoin = {
        $type: 'bpmn:SequenceFlow',
        id: 'F_Join',
        sourceRef: 'GW1',
        targetRef: 'Join1',
      };
      const flowJoinObs = {
        $type: 'bpmn:SequenceFlow',
        id: 'F_JoinObs',
        sourceRef: 'Obs',
        targetRef: 'Join1',
      };
      const flowFail = {
        $type: 'bpmn:SequenceFlow',
        id: 'F_Fail',
        sourceRef: 'GW1',
        targetRef: 'Fail',
      };
      const flowFailDup = {
        $type: 'bpmn:SequenceFlow',
        id: 'F_FailDup',
        sourceRef: 'GW1',
        targetRef: 'Fail',
      };
      const flowNull = {
        $type: 'bpmn:SequenceFlow',
        id: 'F_Null',
        sourceRef: 'GW1',
        targetRef: null,
      };
      const flowSecondJoin = {
        $type: 'bpmn:SequenceFlow',
        id: 'F_SecondJoin',
        sourceRef: 'GW1',
        targetRef: 'Join1',
      };
      const flowDownstream = {
        $type: 'bpmn:SequenceFlow',
        id: 'F_Downstream',
        sourceRef: 'Fail',
        targetRef: 'FailEnd',
      };
      const flowDownstreamNull = {
        $type: 'bpmn:SequenceFlow',
        id: 'F_DownNull',
        sourceRef: 'Fail',
        targetRef: null,
      };
      const flowDownstreamJoin = {
        $type: 'bpmn:SequenceFlow',
        id: 'F_DownJoin',
        sourceRef: 'Fail',
        targetRef: 'Join1',
      };
      const flowDownstreamLoop = {
        $type: 'bpmn:SequenceFlow',
        id: 'F_DownLoop',
        sourceRef: 'Fail',
        targetRef: 'Fail',
      };
      const flowToNoBounds = {
        $type: 'bpmn:SequenceFlow',
        id: 'F_ToNoBounds',
        sourceRef: 'Fail',
        targetRef: 'NoBounds',
      };
      const flowMissingNode = {
        $type: 'bpmn:SequenceFlow',
        id: 'F_Missing',
        sourceRef: 'Fail',
        targetRef: 'MissingNodeId',
      };

      const process = {
        flowElements: [
          gw,
          join,
          obs,
          col1,
          col2,
          noBoundsNode,
          fail,
          failEnd,
          flowJoin,
          flowJoinObs,
          flowFail,
          flowFailDup,
          flowNull,
          flowSecondJoin,
          flowDownstream,
          flowDownstreamNull,
          flowDownstreamJoin,
          flowDownstreamLoop,
          flowToNoBounds,
          flowMissingNode,
        ],
      };

      const result: ScopeLayoutResult = {
        width: 800,
        height: 400,
        minX: 100,
        minY: 100,
        shapes: [
          { element: gw, bounds: { x: 100, y: 100, width: 50, height: 50 } },
          { element: join, bounds: { x: 600, y: 200, width: 50, height: 50 } },
          { element: obs, bounds: { x: 100, y: 160, width: 100, height: 80 } },
          { element: col1, bounds: { x: 300, y: 160, width: 100, height: 80 } },
          { element: col2, bounds: { x: 350, y: 160, width: 100, height: 80 } },
          { element: fail, bounds: { x: 180, y: 100, width: 100, height: 50 } },
          { element: failEnd, bounds: { x: 320, y: 100, width: 36, height: 36 } },
        ],
        edges: [
          {
            element: flowJoin,
            waypoints: [
              { x: 125, y: 150 },
              { x: 600, y: 225 },
            ],
          },
          {
            element: flowFail,
            waypoints: [
              { x: 150, y: 125 },
              { x: 180, y: 125 },
            ],
          },
        ],
      };

      const res = alignIntraProcessBranches({ process, result });
      expect(res).toBe(true);
      expect(result.shapes[0].bounds.x).toBe(300);
    });

    it('returns false when candidate gateway shift causes overlap with an existing node', () => {
      const gw = { id: 'G1', $type: 'bpmn:ExclusiveGateway' };
      const join = { id: 'G2', $type: 'bpmn:ExclusiveGateway' };
      const obs = { id: 'T_obs', $type: 'bpmn:Task' };
      const col1 = { id: 'T_col1', $type: 'bpmn:Task' };
      const obstacleAtTarget = { id: 'T_block', $type: 'bpmn:Task' };

      const flowJoin = { id: 'F_join', $type: 'bpmn:SequenceFlow', sourceRef: gw, targetRef: join };
      const flowOther = {
        id: 'F_other',
        $type: 'bpmn:SequenceFlow',
        sourceRef: gw,
        targetRef: join,
      };

      const process = {
        flowElements: [gw, join, obs, col1, obstacleAtTarget, flowJoin, flowOther],
      };

      const result: ScopeLayoutResult = {
        width: 1000,
        height: 600,
        minX: 100,
        minY: 100,
        shapes: [
          { element: gw, bounds: { x: 100, y: 100, width: 50, height: 50 } },
          { element: join, bounds: { x: 600, y: 200, width: 50, height: 50 } },
          { element: obs, bounds: { x: 100, y: 160, width: 100, height: 80 } },
          { element: col1, bounds: { x: 300, y: 160, width: 100, height: 80 } },
          { element: obstacleAtTarget, bounds: { x: 300, y: 100, width: 100, height: 80 } },
        ],
        edges: [
          {
            element: flowJoin,
            waypoints: [
              { x: 125, y: 150 },
              { x: 600, y: 225 },
            ],
          },
        ],
      };

      const res = alignIntraProcessBranches({ process, result });
      expect(res).toBe(false);
    });
  });

  describe('alignVerticallyStackedPaths', () => {
    it('handles collaboration without participants or processes', () => {
      const ctx: any = {
        definitions: { rootElements: [] },
        collaboration: { participants: [] },
        allShapes: [],
        allEdges: [],
        allShapesMap: new Map(),
      };
      alignVerticallyStackedPaths(ctx);
      expect(ctx.allShapes).toEqual([]);
    });

    it('handles undefined collaboration, string processRef, unknown process, and undefined rootElements', () => {
      alignVerticallyStackedPaths({
        definitions: {},
        collaboration: undefined,
        allShapes: [],
        allEdges: [],
        allShapesMap: new Map(),
      });

      const ctx: any = {
        definitions: {},
        collaboration: {
          participants: [{ processRef: 'UnknownProc' }, { processRef: { id: 'UnknownProc2' } }],
          messageFlows: [],
        },
        allShapes: [],
        allEdges: [],
        allShapesMap: new Map(),
      };
      alignVerticallyStackedPaths(ctx);
      expect(ctx.allShapes).toEqual([]);
    });

    it('runs intra-process alignment and collaboration alignment for participants', () => {
      const proc = {
        id: 'P1',
        $type: 'bpmn:Process',
        flowElements: [{ id: 'T1', $type: 'bpmn:Task' }],
      };
      const shapeT1 = { element: { id: 'T1' }, bounds: { x: 100, y: 100, width: 100, height: 80 } };
      const ctx: any = {
        definitions: { rootElements: [proc] },
        collaboration: {
          participants: [{ processRef: 'P1' }],
          messageFlows: [],
        },
        allShapes: [shapeT1],
        allEdges: [],
        allShapesMap: new Map([['T1', shapeT1.bounds]]),
      };
      alignVerticallyStackedPaths(ctx);
      expect(shapeT1.bounds.x).toBe(100);
    });
  });
});
