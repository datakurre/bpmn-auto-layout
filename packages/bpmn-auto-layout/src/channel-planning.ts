/**
 * Channel planning — two-pass greedy lane assignment for loop-back and bypass
 * edges.
 *
 * First pass (recorder): every flow that needs a channel calls `channelY` and
 * records its span; the placeholder Y keeps the rest of the routing code
 * running.  Second pass (resolve): lanes are assigned greedily, longest-span
 * first, so a long loop-back nests outside a short one rather than crossing
 * it.  Two edges share a lane only when their spans do not overlap at all.
 */

import type { ChannelPlan, NodeLayout } from "./layout-types";
import { CHANNEL_CLEARANCE, CHANNEL_LANE_GAP } from "./element-dimensions";

/**
 * Plan channels from the band occupied by exactly the nodes passed in.
 * Callers scope `nodes` to one container (the top-level diagram, or one
 * expanded subprocess's own children) -- see planContainerScopedChannels,
 * which is what routing actually uses. A bare call with a mixed node set
 * would band across containers, which is the bug #26 describes.
 */
export function planChannels(nodes: Map<string, NodeLayout>): {
  recorder: ChannelPlan;
  resolve: () => ChannelPlan;
} {
  const tops = Array.from(nodes.values());
  const bandTop = tops.length ? Math.min(...tops.map((n) => n.y)) : 0;
  const bandBottom = tops.length ? Math.max(...tops.map((n) => n.y + n.height)) : 0;

  const laneY = (side: "above" | "below", lane: number): number =>
    side === "below"
      ? bandBottom + CHANNEL_CLEARANCE + lane * CHANNEL_LANE_GAP
      : bandTop - CHANNEL_CLEARANCE - lane * CHANNEL_LANE_GAP;

  interface Request {
    flowId: string;
    side: "above" | "below";
    lo: number;
    hi: number;
  }
  const requests: Request[] = [];

  const recorder: ChannelPlan = {
    channelY(flowId, side, x1, x2) {
      requests.push({ flowId, side, lo: Math.min(x1, x2), hi: Math.max(x1, x2) });
      return laneY(side, 0);
    },
  };

  const resolve = (): ChannelPlan => {
    const assigned = new Map<string, number>();
    for (const side of ["below", "above"] as const) {
      const mine = requests
        .filter((r) => r.side === side)
        .sort((a, b) => b.hi - b.lo - (a.hi - a.lo));
      const lanes: Array<Array<{ lo: number; hi: number }>> = [];
      for (const req of mine) {
        let lane = 0;
        while (lanes[lane]?.some((iv) => Math.min(iv.hi, req.hi) - Math.max(iv.lo, req.lo) > 0)) {
          lane += 1;
        }
        (lanes[lane] ??= []).push({ lo: req.lo, hi: req.hi });
        assigned.set(req.flowId, lane);
      }
    }
    return {
      channelY(flowId, side) {
        return laneY(side, assigned.get(flowId) ?? 0);
      },
    };
  };

  return { recorder, resolve };
}

/**
 * Container-scoped channel planning: groups `nodes` by their immediate
 * container (the top-level diagram, or one expanded subprocess), plans
 * channels independently within each group, and returns one combined
 * ChannelPlan that dispatches each flow to its own container's plan. A
 * subprocess-internal loop-back or bypass channel is then bounded by that
 * subprocess's own content band, never by the outer diagram's (#26).
 */
export function planContainerScopedChannels(
  nodes: Map<string, NodeLayout>,
  flows: any[],
): { recorder: ChannelPlan; resolve: () => ChannelPlan } {
  const groups = new Map<string | undefined, Map<string, NodeLayout>>();
  for (const [id, node] of nodes) {
    const key = node.isSubProcessChild ? node.containerId : undefined;
    (groups.get(key) ?? groups.set(key, new Map()).get(key)!).set(id, node);
  }
  const perContainer = new Map<string | undefined, ReturnType<typeof planChannels>>();
  for (const [key, groupNodes] of groups) perContainer.set(key, planChannels(groupNodes));

  const flowContainer = new Map<string, string | undefined>();
  for (const flow of flows) {
    const src = nodes.get(flow.sourceRef?.id);
    if (src) flowContainer.set(flow.id, src.isSubProcessChild ? src.containerId : undefined);
  }

  const recorder: ChannelPlan = {
    channelY(flowId, side, x1, x2) {
      const plan = perContainer.get(flowContainer.get(flowId)) ?? perContainer.get(undefined);
      return plan ? plan.recorder.channelY(flowId, side, x1, x2) : 0;
    },
  };

  const resolve = (): ChannelPlan => {
    const resolved = new Map<string | undefined, ChannelPlan>();
    for (const [key, plan] of perContainer) resolved.set(key, plan.resolve());
    return {
      channelY(flowId, side, x1, x2) {
        const plan = resolved.get(flowContainer.get(flowId)) ?? resolved.get(undefined);
        return plan ? plan.channelY(flowId, side, x1, x2) : 0;
      },
    };
  };

  return { recorder, resolve };
}
