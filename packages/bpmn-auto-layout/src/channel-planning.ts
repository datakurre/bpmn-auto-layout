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

export function planChannels(nodes: Map<string, NodeLayout>): {
  recorder: ChannelPlan;
  resolve: () => ChannelPlan;
} {
  const tops: NodeLayout[] = [];
  for (const n of nodes.values()) if (!n.isSubProcessChild) tops.push(n);
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
