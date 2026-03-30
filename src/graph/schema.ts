export type GraphNodeType = 'function' | 'variable' | 'module';
export type GraphEdgeType = 'call' | 'dependency' | 'contains';
export type GraphEdgeProvenance = 'containment' | 'ast' | 'import-map' | 'heuristic';

export interface GraphNodeMetadata {
  moduleNodeId?: string;
  external?: boolean;
  unresolved?: boolean;
  [key: string]: unknown;
}

export interface GraphEdgeMetadata {
  confidence?: number;
  provenance?: GraphEdgeProvenance;
  reason?: string;
  [key: string]: unknown;
}

export interface GraphDiagnostics {
  resolvedCalls: number;
  unresolvedCalls: number;
  ambiguousCalls: number;
  parserCacheHits: number;
  parserCacheMisses: number;
}

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  filePath?: string;
  line?: number;
  moduleName?: string;
  metadata?: GraphNodeMetadata;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  metadata?: GraphEdgeMetadata;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: {
    workspaceName: string;
    generatedAt: string;
    fileCount: number;
    engineVersion: string;
    diagnostics: GraphDiagnostics;
    parseWarnings: string[];
  };
}
