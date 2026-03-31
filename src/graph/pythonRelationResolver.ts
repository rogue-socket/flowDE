import { GraphEdge, GraphNode } from './schema';
import {
  ImportBinding,
  IndexedCallReference,
  IndexedClassSymbol,
  IndexedFunctionSymbol,
  IndexedModule,
  IndexedVariableSymbol,
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

    const classSymbols: IndexedClassSymbol[] = [];
    const functionSymbols: IndexedFunctionSymbol[] = [];
    const variableSymbols: IndexedVariableSymbol[] = [];
    const callRefs: IndexedCallReference[] = [];
    const dataFlowRefs: Array<{
      sourceNodeId: string;
      targetNodeId: string;
      variableName?: string;
      reason: string;
    }> = [];

    for (const module of modules) {
      nodes.push(module.moduleNode);
      moduleNameToNodeId.set(module.moduleName, module.moduleNode.id);
      importBindingsByModuleId.set(module.moduleNode.id, module.importBindings);
      dependenciesByModuleId.set(module.moduleNode.id, new Set(module.dependencies));

      for (const dependency of module.dependencies) {
        dependencyRecords.push({ sourceModuleId: module.moduleNode.id, dependency });
      }

      classSymbols.push(...module.classes);
      functionSymbols.push(...module.functions);
      variableSymbols.push(...module.variables);
      callRefs.push(...module.callRefs);
      dataFlowRefs.push(...module.dataFlowRefs);
    }

    nodes.push(
      ...classSymbols.map((symbol) => ({
        id: symbol.id,
        type: 'class' as const,
        name: symbol.name,
        layers: ['structural', 'dependency'] as GraphNode['layers'],
        roles: ['type'] as GraphNode['roles'],
        filePath: symbol.filePath,
        line: symbol.line,
        moduleName: symbol.moduleName,
        metadata: {
          moduleNodeId: symbol.moduleNodeId
        }
      }))
    );

    nodes.push(
      ...functionSymbols.map((symbol) => ({
        id: symbol.id,
        type: 'function' as const,
        name: symbol.name,
        layers: ['structural', 'dependency', 'dataflow'] as GraphNode['layers'],
        roles: ['callable', 'transform'] as GraphNode['roles'],
        filePath: symbol.filePath,
        line: symbol.line,
        moduleName: symbol.moduleName,
        metadata: {
          moduleNodeId: symbol.moduleNodeId,
          classNodeId: symbol.classNodeId
        }
      }))
    );

    nodes.push(
      ...variableSymbols.map((symbol) => ({
        id: symbol.id,
        type: 'variable' as const,
        name: symbol.name,
        layers: ['structural', 'dataflow'] as GraphNode['layers'],
        roles: ['state'] as GraphNode['roles'],
        filePath: symbol.filePath,
        line: symbol.line,
        moduleName: symbol.moduleName,
        metadata: {
          moduleNodeId: symbol.moduleNodeId,
          functionNodeId: symbol.functionNodeId
        }
      }))
    );

    const functionSymbolsByName = new Map<string, IndexedFunctionSymbol[]>();
    const functionSymbolsByModuleAndName = new Map<string, IndexedFunctionSymbol[]>();
    const classSymbolsByName = new Map<string, IndexedClassSymbol[]>();

    for (const symbol of functionSymbols) {
      const list = functionSymbolsByName.get(symbol.name) ?? [];
      list.push(symbol);
      functionSymbolsByName.set(symbol.name, list);

      const scopedKey = this.functionScopeKey(symbol.moduleName, symbol.name);
      const scopedList = functionSymbolsByModuleAndName.get(scopedKey) ?? [];
      scopedList.push(symbol);
      functionSymbolsByModuleAndName.set(scopedKey, scopedList);
    }

    for (const symbol of classSymbols) {
      const list = classSymbolsByName.get(symbol.name) ?? [];
      list.push(symbol);
      classSymbolsByName.set(symbol.name, list);
    }

    for (const symbol of classSymbols) {
      this.addEdge(edges, uniqueEdgeIds, {
        id: `edge:contains:${symbol.moduleNodeId}->${symbol.id}`,
        source: symbol.moduleNodeId,
        target: symbol.id,
        type: 'contains',
        layer: 'structural',
        metadata: {
          confidence: 1,
          provenance: 'containment',
          reason: 'Class is declared in module.'
        }
      });
    }

    for (const symbol of functionSymbols) {
      const parentNodeId = symbol.classNodeId ?? symbol.moduleNodeId;
      this.addEdge(edges, uniqueEdgeIds, {
        id: `edge:contains:${parentNodeId}->${symbol.id}`,
        source: parentNodeId,
        target: symbol.id,
        type: 'contains',
        layer: 'structural',
        metadata: {
          confidence: 1,
          provenance: 'containment',
          reason: symbol.classNodeId
            ? 'Method is declared in class.'
            : 'Function is declared in module.'
        }
      });
    }

    for (const symbol of variableSymbols) {
      const parentNodeId = symbol.functionNodeId ?? symbol.moduleNodeId;
      this.addEdge(edges, uniqueEdgeIds, {
        id: `edge:contains:${parentNodeId}->${symbol.id}`,
        source: parentNodeId,
        target: symbol.id,
        type: 'contains',
        layer: 'structural',
        metadata: {
          confidence: 1,
          provenance: 'containment',
          reason: symbol.functionNodeId
            ? 'Variable is tracked inside function scope.'
            : 'Variable is tracked at module scope.'
        }
      });
    }

    let resolvedCalls = 0;
    let unresolvedCalls = 0;
    let ambiguousCalls = 0;
    let classUsageEdges = 0;
    let dataFlowEdges = 0;

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
        this.addEdge(edges, uniqueEdgeIds, {
          id: `edge:call:${callRef.sourceFunctionId}->${resolution.targetFunctionId}`,
          source: callRef.sourceFunctionId,
          target: resolution.targetFunctionId,
          type: 'call',
          layer: 'dependency',
          metadata: {
            confidence: resolution.confidence,
            provenance: resolution.provenance,
            reason: resolution.reason
          }
        });
      } else {
        unresolvedCalls += 1;
        if (resolution.ambiguous) {
          ambiguousCalls += 1;
        }
      }

      const classUsageTarget = this.resolveClassUsageTarget(callRef, classSymbolsByName);
      if (classUsageTarget) {
        classUsageEdges += 1;
        this.addEdge(edges, uniqueEdgeIds, {
          id: `edge:class-usage:${callRef.sourceFunctionId}->${classUsageTarget.id}`,
          source: callRef.sourceFunctionId,
          target: classUsageTarget.id,
          type: 'class-usage',
          layer: 'dependency',
          metadata: {
            confidence: 0.65,
            provenance: 'heuristic',
            reason: `Call expression references class-like symbol ${classUsageTarget.name}.`
          }
        });
      }
    }

    for (const ref of dataFlowRefs) {
      if (!this.nodeExists(nodes, ref.sourceNodeId) || !this.nodeExists(nodes, ref.targetNodeId)) {
        continue;
      }

      const edgeId = `edge:dataflow:${ref.sourceNodeId}->${ref.targetNodeId}:${ref.reason}:${ref.variableName ?? '_'}`;
      dataFlowEdges += 1;
      this.addEdge(edges, uniqueEdgeIds, {
        id: edgeId,
        source: ref.sourceNodeId,
        target: ref.targetNodeId,
        type: 'dataflow',
        layer: 'dataflow',
        metadata: {
          confidence: 0.58,
          provenance: 'ast',
          reason: ref.reason,
          variable: ref.variableName
        }
      });
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
            layers: ['structural', 'dependency'],
            roles: ['container', 'external'],
            metadata: { external: true }
          };
          externalModuleNodes.set(moduleName, externalNode);
        }
      }

      this.addEdge(edges, uniqueEdgeIds, {
        id: `edge:dependency:${record.sourceModuleId}->${targetModuleId}`,
        source: record.sourceModuleId,
        target: targetModuleId,
        type: 'dependency',
        layer: 'dependency',
        metadata: {
          confidence: 0.88,
          provenance: 'ast',
          reason: 'Derived from import statement.'
        }
      });
    }

    nodes.push(...externalModuleNodes.values());

    return {
      nodes,
      edges,
      diagnostics: {
        resolvedCalls,
        unresolvedCalls,
        ambiguousCalls,
        classUsageEdges,
        dataFlowEdges,
        indexedClasses: classSymbols.length,
        indexedVariables: variableSymbols.length
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

  private nodeExists(nodes: GraphNode[], nodeId: string): boolean {
    return nodes.some((node) => node.id === nodeId);
  }

  private resolveClassUsageTarget(
    callRef: IndexedCallReference,
    classSymbolsByName: Map<string, IndexedClassSymbol[]>
  ): IndexedClassSymbol | undefined {
    const firstToken = callRef.calleePath[0];
    if (!firstToken || firstToken === 'self' || firstToken === 'cls') {
      return undefined;
    }

    const classCandidates = classSymbolsByName.get(firstToken);
    if (!classCandidates || classCandidates.length !== 1) {
      return undefined;
    }

    return classCandidates[0];
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
