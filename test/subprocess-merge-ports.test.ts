import { describe, it, expect } from 'vitest';
import {
  assignMergeIncomingPorts,
  computeMergeTargetPorts,
  type IncomingFlowCandidate,
  type ScopeRouteContext,
} from '../src/hierarchy/subprocess-layout';
import type { Bounds } from '../src/types';

describe('subprocess-layout merge port assignment', () => {
  const gwBounds: Bounds = { x: 300, y: 200, width: 50, height: 50 };

  it('assigns ports with feedback, backward, center, and multiple above/below flows', () => {
    const flows: IncomingFlowCandidate[] = [
      // Backward flow
      {
        flow: { id: 'F_Back' },
        sourceBounds: { x: 350, y: 100, width: 100, height: 80 },
      },
      // Explicit feedback flow
      {
        flow: { id: 'F_Feed' },
        sourceBounds: { x: 100, y: 100, width: 100, height: 80 },
        isFeedback: true,
      },
      // Center forward flow (gwCenterY = 225, srcCenterY = 225)
      {
        flow: { id: 'F_Center' },
        sourceBounds: { x: 100, y: 185, width: 100, height: 80 },
      },
      // Multiple above flows (diff < -2)
      {
        flow: { id: 'F_AboveFar' },
        sourceBounds: { x: 50, y: 50, width: 100, height: 80 },
      },
      {
        flow: { id: 'F_AboveNear' },
        sourceBounds: { x: 150, y: 50, width: 100, height: 80 },
      },
      // Multiple below flows (diff > 2)
      {
        flow: { id: 'F_BelowFar' },
        sourceBounds: { x: 50, y: 350, width: 100, height: 80 },
      },
      {
        flow: { id: 'F_BelowNear' },
        sourceBounds: { x: 150, y: 350, width: 100, height: 80 },
      },
    ];

    const ports = assignMergeIncomingPorts(flows, gwBounds);

    expect(ports.get('F_Back')).toBe('left');
    expect(ports.get('F_Feed')).toBe('left');
    expect(ports.get('F_Center')).toBe('left');
    expect(ports.get('F_AboveNear')).toBe('top');
    expect(ports.get('F_AboveFar')).toBe('left');
    expect(ports.get('F_BelowNear')).toBe('bottom');
    expect(ports.get('F_BelowFar')).toBe('left');
  });

  it('assigns single forward flow with feedback flow to left port', () => {
    const flows: IncomingFlowCandidate[] = [
      {
        flow: { id: 'F_ForwardAbove' },
        sourceBounds: { x: 100, y: 100, width: 100, height: 80 },
      },
      {
        flow: { id: 'F_Feedback' },
        sourceBounds: { x: 400, y: 200, width: 100, height: 80 },
        isFeedback: true,
      },
    ];

    const ports = assignMergeIncomingPorts(flows, gwBounds);
    expect(ports.get('F_ForwardAbove')).toBe('left');
    expect(ports.get('F_Feedback')).toBe('left');
  });

  it('handles computeMergeTargetPorts with missing source bounds and single-incoming gateways', () => {
    const gatewaySet = new Set(['GW_Merge', 'GW_Single']);
    const ctx: ScopeRouteContext = {
      regularNodes: [],
      boundaryEvents: [],
      boundsMap: new Map([
        ['GW_Merge', gwBounds],
        ['GW_Single', { x: 500, y: 200, width: 50, height: 50 }],
        ['Task_A', { x: 100, y: 100, width: 100, height: 80 }],
        ['Task_B', { x: 100, y: 300, width: 100, height: 80 }],
      ]),
    };

    const sequenceFlows = [
      // Flow where target is not a gateway
      { id: 'F_Other', sourceRef: 'Task_A', targetRef: 'Task_B' },
      // Flow where source has no bounds in boundsMap (uncovered branch)
      { id: 'F_UnknownSrc', sourceRef: 'Missing_Src', targetRef: 'GW_Merge' },
      // Valid incoming flows for GW_Merge
      { id: 'F_FromA', sourceRef: 'Task_A', targetRef: 'GW_Merge' },
      { id: 'F_FromB', sourceRef: 'Task_B', targetRef: 'GW_Merge' },
      // Single incoming flow for GW_Single
      { id: 'F_ToSingle', sourceRef: 'Task_A', targetRef: 'GW_Single' },
    ];

    const targetPortMap = computeMergeTargetPorts(sequenceFlows, gatewaySet, ctx);

    // GW_Merge has 2 valid incoming flows
    expect(targetPortMap.get('F_FromA')).toBe('top');
    expect(targetPortMap.get('F_FromB')).toBe('bottom');
    // F_ToSingle is skipped because single incoming
    expect(targetPortMap.has('F_ToSingle')).toBe(false);
  });
});
