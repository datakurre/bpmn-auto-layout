export interface GraphNode {
  id: string;
  data: any;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  data: any;
}

export class DirectedGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: Map<string, GraphEdge> = new Map();
  private outgoing: Map<string, GraphEdge[]> = new Map();
  private incoming: Map<string, GraphEdge[]> = new Map();

  public addNode(id: string, data: any): void {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, data });
      this.outgoing.set(id, []);
      this.incoming.set(id, []);
    }
  }

  public addEdge(edge: GraphEdge): void {
    this.edges.set(edge.id, edge);

    const outList = this.outgoing.get(edge.source) || [];
    outList.push(edge);
    this.outgoing.set(edge.source, outList);

    const inList = this.incoming.get(edge.target) || [];
    inList.push(edge);
    this.incoming.set(edge.target, inList);
  }

  public getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  public getNodes(): GraphNode[] {
    return Array.from(this.nodes.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  public getEdges(): GraphEdge[] {
    return Array.from(this.edges.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  public outEdges(nodeId: string): GraphEdge[] {
    const list = this.outgoing.get(nodeId) || [];
    return [...list].sort((a, b) => a.id.localeCompare(b.id));
  }

  public inEdges(nodeId: string): GraphEdge[] {
    const list = this.incoming.get(nodeId) || [];
    return [...list].sort((a, b) => a.id.localeCompare(b.id));
  }
}
