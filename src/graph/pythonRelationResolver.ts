import { GraphEdge, GraphNode } from './schema';
import {
  ImportBinding,
  IndexedCallReference,
  IndexedFunctionSymbol,
  IndexedModule,
  ResolutionResult
} from './semanticTypes';

type ResolutionProvenance = 'containment' | 'ast' | 'import-map' | 'heuristic';

interface CallResolution {
  targetFunctionId?: string;
  confidence: number;
  provenance: ResolutionProvenance;
  reason: string;
  ambiguous: boolean;
}

export class PythonRelationResolver {
  public resolve(modules: IndexedModule[]): ResolutionResult {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const uniqueEdgeIds = new Set<string>();

    const moduleNameToNodeId = new Map<string, string>();
    const importBindingsByModuleId = new Map<string, ImportBinding[]>();
    const dependenciesByModuleId = new Map<string, Set<string>>();
    const dependencyRecords: Array<{ sourceModuleId: string; dependency: string }> = [];
    const externalModuleNodes = new Map<string, GraphNode>();

    const functionSymbols: IndexedFunctionSymbol[] = [];
    const callRefs: IndexedCallReference[] = [];

    for (const module of modules) {
      nodes.push(module.moduleNode);
      moduleNameToNodeId.set(module.moduleName, module.moduleNode.id);
      importBindingsByModuleId.set(module.moduleNode.id, module.importBindings);
      dependenciesByModuleId.set(module.moduleNode.id, new Set(module.dependencies));

      for (const dependency of module.dependencies) {
        dependencyRecords.push({ sourceModuleId: module.moduleNode.id, dependency });
      }

      functionSymbols.push(...module.functions);
      callRefs.push(...module.callRefs);
    }

    nodes.push(
      ...functionSymbols.map((symbol) => ({
        id: symbol.id,
        type: 'function' as const,
        name: symbol.name,
        filePath: symbol.filePath,
        line: symbol.line,
        metadata: {
          moduleNodeId: symbol.moduleNodeId
        }
      }))
    );

    const functionSymbolsByName = new Map<string, IndexedFunctionSymbol[]>();
    const functionSymbolsByModuleAndName = new Map<string, IndexedFunctionSymbol[]>();

    for (const symbol of functionSymbols) {
      const list = functionSymbolsByName.get(symbol.name) ?? [];
      list.push(symbol);
      functionSymbolsByName.set(symbol.name, list);

      const scopedKey = this.functionScopeKey(symbol.moduleName, symbol.name);
      const scopedList = functionSymbolsByModuleAndName.get(scopedKey) ?? [];
      scopedList.push(symbol);
      functionSymbolsByModuleAndName.set(scopedKey, scopedList);
    }

    for (const symbol of functionSymbols) {
      this.addEdge(
        edges,
        uniqueEdgeIds,
        {
          id: `edge:contains:${symbol.moduleNodeId}->${symbol.id}`,
          source: symbol.moduleNodeId,
          target: symbol.id,
          type: 'contains',
          metadata: {
            confidence: 1,
            provenance: 'containment',
            reason: 'Function is declared in module.'
          }
        }
      );
    }

    let resolvedCalls = 0;
    let unresolvedCalls = 0;
    let ambiguousCalls = 0;

    for (const callRef of callRefs) {
      const resolution = this.resolveCallTarget(
        callRef,
        functionSymbolsByName,
        functionSymbolsByModuleAndName,
        importBindingsByModuleId,
        dependenciesByModuleId
      );

      if (resolution.targetFunctionId) {
        resolvedCalls += 1;
        this.addEdge(
          edges,
          uniqueEdgeIds,
          {
            id: `edge:call:${callRef.sourceFunctionId}->${resolution.targetFunctionId}`,
            source: callRef.sourceFunctionId,
            target: resolution.targetFunctionId,
            type: 'call',
            metadata: {
              confidence: resolution.confidence,
              provenance: resolution.provenance,
              reason: resolution.reason
            }
          }
        );
      } else {
        unresolvedCalls += 1;
        if (resolution.ambiguous) {
          ambiguousCalls += 1;
        }
      }
    }

    for (const record of dependencyRecords) {
      const moduleName = record.dependency;
      let targetModuleId = moduleNameToNodeId.get(moduleName);

      if (!targetModuleId) {
        const externalId = `module:external:${moduleName}`;
        targetModuleId = externalId;

        if (!externalModuleNodes.has(moduleName)) {
          const externalNode: GraphNode = {
            id: externalId,
            type: 'module',
            name: moduleName,
            metadata: { external: true }
          };
          externalModuleNodes.set(moduleName, externalNode);
        }
      }

      this.addEdge(
        edges,
        uniqueEdgeIds,
        {
          id: `edge:dependency:${record.sourceModuleId}->${targetModuleId}`,
          source: record.sourceModuleId,
          target: targetModuleId,
          type: 'dependency',
          metadata: {
            confidence: 0.88,
            provenance: 'ast',
            reason: 'Derived from import statement.'
          }
        }
      );
    }

    nodes.push(...externalModuleNodes.values());

    return {
      nodes,
      edges,
      diagnostics: {
        resolvedCalls,
        unresolvedCalls,
        ambiguousCalls
      }
    };
  }

  private addEdge(edges: GraphEdge[], edgeIds: Set<string>, edge: GraphEdge): void {
    if (edgeIds.has(edge.id)) {
      return;
    }

    edgeIds.add(edge.id);
    edges.push(edge);
  }

  private resolveCallTarget(
    callRef: IndexedCallReference,
    functionSymbolsByName: Map<string, IndexedFunctionSymbol[]>,
    functionSymbolsByModuleAndName: Map<string, IndexedFunctionSymbol[]>,
    importBindingsByModuleId: Map<string, ImportBinding[]>,
    dependenciesByModuleId: Map<string, Set<string>>
  ): CallResolution {
    const candidates = functionSymbolsByName.get(callRef.calleeName);
    if (!candidates || candidates.length === 0) {
      return {
        confidence: 0,
        provenance: 'heuristic',
        reason: 'No matching function names found in workspace index.',
        ambiguous: false
      };
    }

    const importBindings = importBindingsByModuleId.get(callRef.sourceModuleId) ?? [];
    const dependencies = dependenciesByModuleId.get(callRef.sourceModuleId) ?? new Set<string>();
    let ambiguous = false;

    if (callRef.calleePath.length > 1) {
      const rootSymbol = callRef.calleePath[0];
      const qualifierPath = callRef.calleePath.slice(1, -1);
      const importedModules = importBindings.filter(
        (binding) => binding.kind === 'module' && binding.alias === rootSymbol
      );

      for (const binding of importedModules) {
        const targetModuleName =
          qualifierPath.length > 0
            ? `${binding.moduleName}.${qualifierPath.join('.')}`
            : binding.moduleName;

        const scopedCandidates = this.lookupScopedCandidates(
          functionSymbolsByModuleAndName,
          targetModuleName,
          callRef.calleeName
        );

        if (scopedCandidates.length === 1) {
          return {
            targetFunctionId: scopedCandidates[0].id,
            confidence: 0.96,
            provenance: 'import-map',
            reason: 'Resolved through module alias import mapping.',
            ambiguous: false
          };
        }

        if (scopedCandidates.length > 1) {
          ambiguous = true;
        }

        const dependencyScopedCandidates = scopedCandidates.filter((candidate) =>
          dependencies.has(candidate.moduleName)
        );

        if (dependencyScopedCandidates.length === 1) {
          return {
            targetFunctionId: dependencyScopedCandidates[0].id,
            confidence: 0.9,
            provenance: 'import-map',
            reason: 'Resolved via module alias and dependency boundary.',
            ambiguous: false
          };
        }

        if (dependencyScopedCandidates.length > 1) {
          ambiguous = true;
        }
      }
    }

    if (callRef.calleePath.length === 1) {
      const importedSymbols = importBindings.filter(
        (binding) => binding.kind === 'symbol' && binding.alias === callRef.calleeName
      );

      const importedSymbolMatches = new Map<string, IndexedFunctionSymbol>();
      for (const binding of importedSymbols) {
        if (!binding.symbolName) {
          continue;
        }

        const scopedCandidates = this.lookupScopedCandidates(
          functionSymbolsByModuleAndName,
          binding.moduleName,
          binding.symbolName
        );

        for (const candidate of scopedCandidates) {
          importedSymbolMatches.set(candidate.id, candidate);
        }
      }

      if (importedSymbolMatches.size === 1) {
        return {
          targetFunctionId: [...importedSymbolMatches.values()][0].id,
          confidence: 0.93,
          provenance: 'import-map',
          reason: 'Resolved through symbol import mapping.',
          ambiguous: false
        };
      }

      if (importedSymbolMatches.size > 1) {
        ambiguous = true;
      }
    }

    const sameModuleCandidates = candidates.filter(
      (candidate) => candidate.moduleName === callRef.sourceModuleName
    );

    if (sameModuleCandidates.length === 1) {
      return {
        targetFunctionId: sameModuleCandidates[0].id,
        confidence: 0.86,
        provenance: 'ast',
        reason: 'Resolved to unique local function candidate in same module.',
        ambiguous: false
      };
    }

    if (sameModuleCandidates.length > 1) {
      ambiguous = true;
    }

    const dependencyScopedCandidates = candidates.filter((candidate) =>
      dependencies.has(candidate.moduleName)
    );

    if (dependencyScopedCandidates.length === 1) {
      return {
        targetFunctionId: dependencyScopedCandidates[0].id,
        confidence: 0.72,
        provenance: 'heuristic',
        reason: 'Resolved to unique function candidate in imported dependency.',
        ambiguous: false
      };
    }

    if (dependencyScopedCandidates.length > 1) {
      ambiguous = true;
    }

    if (candidates.length === 1) {
      return {
        targetFunctionId: candidates[0].id,
        confidence: 0.62,
        provenance: 'heuristic',
        reason: 'Resolved to only global candidate in workspace.',
        ambiguous: false
      };
    }

    return {
      confidence: 0,
      provenance: 'heuristic',
      reason: 'Multiple matching candidates found; leaving unresolved.',
      ambiguous
    };
  }

  private functionScopeKey(moduleName: string, functionName: string): string {
    return `${moduleName}::${functionName}`;
  }

  private lookupScopedCandidates(
    functionSymbolsByModuleAndName: Map<string, IndexedFunctionSymbol[]>,
    moduleName: string,
    functionName: string
  ): IndexedFunctionSymbol[] {
    return functionSymbolsByModuleAndName.get(this.functionScopeKey(moduleName, functionName)) ?? [];
  }
}
