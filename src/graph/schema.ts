export type GraphLayer = 'structural' | 'dependency' | 'dataflow' | 'execution';
export type GraphNodeType = 'function' | 'variable' | 'module' | 'class';
export type GraphNodeRole =
  | 'container'
  | 'callable'
  | 'type'
  | 'state'
  | 'transform'
  | 'external';
export type GraphEdgeType =
  | 'call'
  | 'dependency'
  | 'contains'
  | 'class-usage'
  | 'dataflow'
  | 'execution-path';
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
  classUsageEdges: number;
  dataFlowEdges: number;
  indexedClasses: number;
  indexedVariables: number;
  parserCacheHits: number;
  parserCacheMisses: number;
}

export interface GraphLayerStats {
  nodes: number;
  edges: number;
  visibleByDefault: boolean;
}

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  layers: GraphLayer[];
  roles: GraphNodeRole[];
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
  layer: GraphLayer;
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
    layerStats: Record<GraphLayer, GraphLayerStats>;
    diagnostics: GraphDiagnostics;
    parseWarnings: string[];
  };
}
