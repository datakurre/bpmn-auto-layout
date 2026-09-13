export interface GraphNode {
  id: string;
  data: any;
  order?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  data: any;
  order?: number;
}

export class DirectedGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: Map<string, GraphEdge> = new Map();
  private outgoing: Map<string, GraphEdge[]> = new Map();
  private incoming: Map<string, GraphEdge[]> = new Map();

  public addNode(id: string, data: any, order?: number): void {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, data, order });
      this.outgoing.set(id, []);
      this.incoming.set(id, []);
    }
  }

  public addEdge(edge: GraphEdge): void {
    const fullEdge: GraphEdge = {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      data: edge.data,
      order: edge.order ?? 0,
    };
    this.edges.set(fullEdge.id, fullEdge);

    const outList = this.outgoing.get(fullEdge.source) || [];
    outList.push(fullEdge);
    this.outgoing.set(fullEdge.source, outList);

    const inList = this.incoming.get(fullEdge.target) || [];
    inList.push(fullEdge);
    this.incoming.set(fullEdge.target, inList);
  }

  public getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  public getNodes(): GraphNode[] {
    return Array.from(this.nodes.values()).sort((a, b) => {
      const oA = a.order ?? 0;
      const oB = b.order ?? 0;
      if (oA !== oB) {
        return oA - oB;
      }
      return a.id.localeCompare(b.id);
    });
  }

  public getEdges(): GraphEdge[] {
    // Edge order is always defined here: addEdge defaults it to 0.
    return Array.from(this.edges.values()).sort((a, b) => {
      if (a.order !== b.order) {
        return a.order! - b.order!;
      }
      return a.id.localeCompare(b.id);
    });
  }

  public outEdges(nodeId: string): GraphEdge[] {
    const list = this.outgoing.get(nodeId) || [];
    return [...list].sort((a, b) => {
      if (a.order !== b.order) {
        return a.order! - b.order!;
      }
      return a.id.localeCompare(b.id);
    });
  }

  public inEdges(nodeId: string): GraphEdge[] {
    const list = this.incoming.get(nodeId) || [];
    return [...list].sort((a, b) => {
      if (a.order !== b.order) {
        return a.order! - b.order!;
      }
      return a.id.localeCompare(b.id);
    });
  }
}
