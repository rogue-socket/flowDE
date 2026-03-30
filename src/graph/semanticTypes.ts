import { GraphEdge, GraphNode } from './schema';

export interface IndexedFunctionSymbol {
  id: string;
  name: string;
  filePath: string;
  line: number;
  moduleNodeId: string;
  moduleName: string;
}

export interface IndexedCallReference {
  sourceFunctionId: string;
  sourceModuleId: string;
  sourceModuleName: string;
  calleeName: string;
  calleePath: string[];
}

export interface ImportBinding {
  alias: string;
  kind: 'module' | 'symbol';
  moduleName: string;
  symbolName?: string;
}

export interface IndexedModule {
  relativePath: string;
  moduleName: string;
  moduleNode: GraphNode;
  functions: IndexedFunctionSymbol[];
  callRefs: IndexedCallReference[];
  dependencies: string[];
  importBindings: ImportBinding[];
  warning?: string;
}

export interface IndexingResult {
  modules: IndexedModule[];
  fileCount: number;
  stats: {
    parseWarnings: string[];
    cacheHits: number;
    cacheMisses: number;
  };
}

export interface ResolutionDiagnostics {
  resolvedCalls: number;
  unresolvedCalls: number;
  ambiguousCalls: number;
}

export interface ResolutionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: ResolutionDiagnostics;
}
