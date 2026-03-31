import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PythonWorkspaceGraphBuilder } from './graph/workspaceGraphBuilder';
import { GraphData, GraphNode } from './graph/schema';
import { FLOWDE_PYTHON_TRACER } from './runtime/pythonTraceScript';

type IncomingWebviewMessage =
  | { type: 'ready' }
  | { type: 'refreshGraph' }
  | { type: 'navigateToNode'; nodeId: string }
  | { type: 'startExecutionTrace' }
  | { type: 'stopExecutionTrace' }
  | {
      type: 'createGraphFunction';
      moduleNodeId: string;
      functionName: string;
      inputs: string[];
      outputs: string[];
    }
  | { type: 'connectGraphNodes'; sourceNodeId: string; targetNodeId: string }
  | { type: 'renameGraphNode'; nodeId: string; newName: string }
  | { type: 'moveGraphNode'; nodeId: string; targetModuleNodeId: string };

interface RawRuntimeTraceEvent {
  event: string;
  timestamp?: number;
  file?: string;
  line?: number;
  def_line?: number;
  function?: string;
  qualname?: string;
  locals?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  output?: unknown;
  exception?: string;
  message?: string;
  traceback?: string;
  exit_code?: number;
}

type RuntimeEventType = 'call' | 'line' | 'return' | 'exception';

interface ExecutionRuntimeEvent {
  index: number;
  eventType: RuntimeEventType;
  timestamp: number;
  filePath: string;
  line: number;
  definitionLine?: number;
  functionName: string;
  qualifiedName?: string;
  nodeId?: string;
  inputs?: Record<string, unknown>;
  locals?: Record<string, unknown>;
  output?: unknown;
  exception?: string;
}

interface GraphEditOutcome {
  ok: boolean;
  message: string;
}

interface PythonFunctionBlock {
  start: number;
  end: number;
  indentPrefix: string;
  bodyIndentPrefix: string;
}

const TRACE_PREFIX = 'FLOWDE_TRACE:';
const PYTHON_EXCLUDE_GLOB = '**/{.git,node_modules,.venv,venv,__pycache__,dist}/**';
const PYTHON_KEYWORDS = new Set([
  'and',
  'as',
  'assert',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'false',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'none',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'true',
  'try',
  'while',
  'with',
  'yield'
]);

export function activate(context: vscode.ExtensionContext): void {
  const graphBuilder = new PythonWorkspaceGraphBuilder();
  let flowPanel: FlowDEPanel | undefined;

  const openGraphCommand = vscode.commands.registerCommand('flowde.openGraphView', async () => {
    const workspaceFolder = resolveWorkspaceFolder();

    if (!workspaceFolder) {
      vscode.window.showWarningMessage('FlowDE needs an open workspace folder to build a graph.');
      return;
    }

    if (flowPanel) {
      flowPanel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'flowde.graph',
      'FlowDE Graph',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );

    flowPanel = new FlowDEPanel(panel, context.extensionUri, workspaceFolder, graphBuilder, () => {
      flowPanel = undefined;
    });

    context.subscriptions.push(flowPanel);
  });

  context.subscriptions.push(openGraphCommand);
}

export function deactivate(): void {
  // No-op for MVP.
}

class FlowDEPanel implements vscode.Disposable {
  private readonly nodeById = new Map<string, GraphNode>();
  private readonly functionNodesByScope = new Map<string, GraphNode[]>();
  private readonly moduleNodeByPath = new Map<string, GraphNode>();
  private readonly classNameById = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watcher: vscode.FileSystemWatcher;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshInFlight = false;
  private refreshQueued = false;
  private runtimeProcess: ChildProcessWithoutNullStreams | undefined;
  private runtimeOutputBuffer = '';
  private runtimeEventCount = 0;
  private runtimeCompletionSent = false;

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly graphBuilder: PythonWorkspaceGraphBuilder,
    private readonly onDispose: () => void
  ) {
    this.panel.webview.html = this.getWebviewHtml(this.panel.webview);

    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceFolder, '**/*.py')
    );

    this.disposables.push(this.watcher);

    this.watcher.onDidCreate(() => this.scheduleRefresh(), this, this.disposables);
    this.watcher.onDidChange(() => this.scheduleRefresh(), this, this.disposables);
    this.watcher.onDidDelete(() => this.scheduleRefresh(), this, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message: IncomingWebviewMessage) => this.handleMessage(message),
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  public dispose(): void {
    this.stopExecutionTrace(true);
    this.onDispose();

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  private handleMessage(message: IncomingWebviewMessage): void {
    switch (message.type) {
      case 'ready':
      case 'refreshGraph': {
        void this.refreshGraph();
        break;
      }
      case 'navigateToNode': {
        void this.navigateToNode(message.nodeId);
        break;
      }
      case 'startExecutionTrace': {
        void this.startExecutionTrace();
        break;
      }
      case 'stopExecutionTrace': {
        this.stopExecutionTrace(false);
        break;
      }
      case 'createGraphFunction': {
        void this.createGraphFunction(message.moduleNodeId, message.functionName, message.inputs, message.outputs);
        break;
      }
      case 'connectGraphNodes': {
        void this.connectGraphNodes(message.sourceNodeId, message.targetNodeId);
        break;
      }
      case 'renameGraphNode': {
        void this.renameGraphNode(message.nodeId, message.newName);
        break;
      }
      case 'moveGraphNode': {
        void this.moveGraphNode(message.nodeId, message.targetModuleNodeId);
        break;
      }
      default:
        break;
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      void this.refreshGraph();
    }, 300);
  }

  private async refreshGraph(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }

    this.refreshInFlight = true;

    try {
      const graphData = await this.graphBuilder.buildGraph(this.workspaceFolder);
      this.nodeById.clear();
      for (const node of graphData.nodes) {
        this.nodeById.set(node.id, node);
      }
      this.rebuildRuntimeLookupIndexes();

      await this.postGraphData(graphData);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.panel.webview.postMessage({ type: 'graphError', message });
    } finally {
      this.refreshInFlight = false;

      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refreshGraph();
      }
    }
  }

  private rebuildRuntimeLookupIndexes(): void {
    this.functionNodesByScope.clear();
    this.moduleNodeByPath.clear();
    this.classNameById.clear();

    for (const node of this.nodeById.values()) {
      if (node.type === 'module' && node.filePath) {
        this.moduleNodeByPath.set(node.filePath, node);
        continue;
      }

      if (node.type === 'class') {
        this.classNameById.set(node.id, node.name);
        continue;
      }

      if (node.type !== 'function' || !node.filePath) {
        continue;
      }

      const key = this.functionScopeKey(node.filePath, node.name);
      const existing = this.functionNodesByScope.get(key) ?? [];
      existing.push(node);
      this.functionNodesByScope.set(key, existing);
    }

    for (const [key, nodes] of this.functionNodesByScope.entries()) {
      this.functionNodesByScope.set(
        key,
        [...nodes].sort((a, b) => {
          const lineA = typeof a.line === 'number' ? a.line : Number.MAX_SAFE_INTEGER;
          const lineB = typeof b.line === 'number' ? b.line : Number.MAX_SAFE_INTEGER;
          return lineA - lineB;
        })
      );
    }
  }

  private async startExecutionTrace(): Promise<void> {
    if (this.runtimeProcess) {
      vscode.window.showInformationMessage('FlowDE trace is already running. Stop it before starting a new run.');
      return;
    }

    if (this.nodeById.size === 0) {
      await this.refreshGraph();
    }

    const entryUri = await this.resolveExecutionEntryFile();
    if (!entryUri) {
      return;
    }

    const relativeEntryPath = this.toWorkspaceRelativePath(entryUri.fsPath) ?? path.basename(entryUri.fsPath);

    this.runtimeOutputBuffer = '';
    this.runtimeEventCount = 0;
    this.runtimeCompletionSent = false;

    await this.panel.webview.postMessage({
      type: 'executionReset',
      entryFilePath: relativeEntryPath
    });

    try {
      const tracerPath = await this.writeTracerScript();
      this.runtimeProcess = await this.spawnTraceProcess(tracerPath, entryUri.fsPath);

      this.runtimeProcess.stderr.on('data', (chunk: Buffer | string) => {
        this.handleRuntimeOutput(chunk.toString());
      });

      this.runtimeProcess.on('close', (code, signal) => {
        const stopped = signal === 'SIGTERM';
        this.runtimeProcess = undefined;

        if (!this.runtimeCompletionSent) {
          void this.postExecutionComplete({
            totalEvents: this.runtimeEventCount,
            exitCode: typeof code === 'number' ? code : undefined,
            stopped
          });
        }
      });

      this.runtimeProcess.on('error', (error: Error) => {
        this.runtimeProcess = undefined;
        void this.panel.webview.postMessage({
          type: 'executionError',
          message: `Trace process error: ${error.message}`
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.panel.webview.postMessage({
        type: 'executionError',
        message: `Unable to start runtime trace: ${message}`
      });
    }
  }

  private stopExecutionTrace(silent: boolean): void {
    if (!this.runtimeProcess) {
      return;
    }

    this.runtimeCompletionSent = true;
    this.runtimeProcess.kill('SIGTERM');
    this.runtimeProcess = undefined;

    if (!silent) {
      void this.postExecutionComplete({
        totalEvents: this.runtimeEventCount,
        stopped: true
      });
    }
  }

  private async resolveExecutionEntryFile(): Promise<vscode.Uri | undefined> {
    const activeDocument = vscode.window.activeTextEditor?.document;
    if (activeDocument && activeDocument.uri.scheme === 'file' && activeDocument.uri.fsPath.endsWith('.py')) {
      const relative = this.toWorkspaceRelativePath(activeDocument.uri.fsPath);
      if (relative) {
        return activeDocument.uri;
      }
    }

    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri: this.workspaceFolder.uri,
      filters: {
        Python: ['py']
      },
      openLabel: 'Select Python entry file to trace'
    });

    if (!picked || picked.length === 0) {
      return undefined;
    }

    const selected = picked[0];
    if (!this.toWorkspaceRelativePath(selected.fsPath)) {
      vscode.window.showWarningMessage('FlowDE trace entry file must be inside the current workspace folder.');
      return undefined;
    }

    return selected;
  }

  private async writeTracerScript(): Promise<string> {
    const scriptPath = path.join(os.tmpdir(), 'flowde-python-runtime-tracer.py');
    await fs.writeFile(scriptPath, FLOWDE_PYTHON_TRACER, 'utf8');
    return scriptPath;
  }

  private async spawnTraceProcess(
    tracerPath: string,
    entryPath: string
  ): Promise<ChildProcessWithoutNullStreams> {
    const args = [tracerPath, entryPath, this.workspaceFolder.uri.fsPath];

    try {
      return await this.spawnWithCommand('python3', args);
    } catch {
      return this.spawnWithCommand('python', args);
    }
  }

  private spawnWithCommand(
    command: string,
    args: string[]
  ): Promise<ChildProcessWithoutNullStreams> {
    return new Promise((resolve, reject) => {
      const process = spawn(command, args, {
        cwd: this.workspaceFolder.uri.fsPath,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      process.stdin.end();

      let settled = false;

      process.once('error', (error) => {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      });

      process.once('spawn', () => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(process);
      });
    });
  }

  private handleRuntimeOutput(chunk: string): void {
    this.runtimeOutputBuffer += chunk;
    const lines = this.runtimeOutputBuffer.split(/\r?\n/);
    this.runtimeOutputBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith(TRACE_PREFIX)) {
        continue;
      }

      const payloadText = line.slice(TRACE_PREFIX.length);
      this.processRuntimeTracePayload(payloadText);
    }
  }

  private processRuntimeTracePayload(payloadText: string): void {
    try {
      const rawPayload = JSON.parse(payloadText) as RawRuntimeTraceEvent;

      if (rawPayload.event === 'trace_complete') {
        void this.postExecutionComplete({
          totalEvents: this.runtimeEventCount,
          exitCode: typeof rawPayload.exit_code === 'number' ? rawPayload.exit_code : undefined
        });
        return;
      }

      if (rawPayload.event === 'trace_error') {
        const errorMessage = rawPayload.traceback
          ? `${rawPayload.message ?? 'Trace error'}\n${rawPayload.traceback}`
          : rawPayload.message ?? 'Trace error';
        void this.panel.webview.postMessage({ type: 'executionError', message: errorMessage });
        return;
      }

      const mappedEvent = this.mapRuntimeEvent(rawPayload);
      if (!mappedEvent) {
        return;
      }

      void this.panel.webview.postMessage({
        type: 'executionEvent',
        payload: mappedEvent
      });
    } catch {
      // Ignore malformed trace lines.
    }
  }

  private async postExecutionComplete(summary: {
    totalEvents: number;
    exitCode?: number;
    stopped?: boolean;
  }): Promise<void> {
    this.runtimeCompletionSent = true;
    await this.panel.webview.postMessage({
      type: 'executionComplete',
      summary
    });
  }

  private mapRuntimeEvent(rawEvent: RawRuntimeTraceEvent): ExecutionRuntimeEvent | undefined {
    const eventType = rawEvent.event;
    if (eventType !== 'call' && eventType !== 'line' && eventType !== 'return' && eventType !== 'exception') {
      return undefined;
    }

    if (!rawEvent.file || typeof rawEvent.line !== 'number' || !rawEvent.function) {
      return undefined;
    }

    const relativePath = this.toWorkspaceRelativePath(rawEvent.file);
    if (!relativePath) {
      return undefined;
    }

    const nodeId = this.resolveRuntimeNodeId(
      relativePath,
      rawEvent.function,
      rawEvent.qualname,
      rawEvent.def_line,
      rawEvent.line
    );

    const event: ExecutionRuntimeEvent = {
      index: this.runtimeEventCount,
      eventType,
      timestamp: typeof rawEvent.timestamp === 'number' ? rawEvent.timestamp : Date.now() / 1000,
      filePath: relativePath,
      line: rawEvent.line,
      functionName: rawEvent.function,
      qualifiedName: rawEvent.qualname,
      definitionLine: rawEvent.def_line,
      nodeId,
      inputs: rawEvent.inputs,
      locals: rawEvent.locals,
      output: rawEvent.output,
      exception: rawEvent.exception
    };

    this.runtimeEventCount += 1;
    return event;
  }

  private resolveRuntimeNodeId(
    relativePath: string,
    functionName: string,
    qualifiedName: string | undefined,
    definitionLine: number | undefined,
    runtimeLine: number
  ): string | undefined {
    if (functionName === '<module>') {
      return this.moduleNodeByPath.get(relativePath)?.id;
    }

    const key = this.functionScopeKey(relativePath, functionName);
    const candidates = this.functionNodesByScope.get(key) ?? [];

    if (candidates.length === 0) {
      return this.moduleNodeByPath.get(relativePath)?.id;
    }

    if (typeof definitionLine === 'number') {
      const exact = candidates.find((candidate) => candidate.line === definitionLine);
      if (exact) {
        return exact.id;
      }
    }

    const className = this.classNameFromQualifiedName(qualifiedName);
    if (className) {
      const classScoped = candidates.filter((candidate) => this.functionBelongsToClass(candidate, className));
      if (classScoped.length === 1) {
        return classScoped[0].id;
      }
      if (classScoped.length > 1) {
        return this.closestLineMatch(classScoped, runtimeLine).id;
      }
    }

    if (candidates.length === 1) {
      return candidates[0].id;
    }

    return this.closestLineMatch(candidates, runtimeLine).id;
  }

  private classNameFromQualifiedName(qualifiedName: string | undefined): string | undefined {
    if (!qualifiedName || !qualifiedName.includes('.')) {
      return undefined;
    }

    const segments = qualifiedName.split('.').filter((segment) => segment.length > 0);
    if (segments.length < 2) {
      return undefined;
    }

    return segments[segments.length - 2];
  }

  private functionBelongsToClass(node: GraphNode, className: string): boolean {
    const classNodeId = node.metadata?.classNodeId;
    if (typeof classNodeId !== 'string') {
      return false;
    }

    return this.classNameById.get(classNodeId) === className;
  }

  private closestLineMatch(candidates: GraphNode[], runtimeLine: number): GraphNode {
    return [...candidates].sort((a, b) => {
      const lineA = typeof a.line === 'number' ? a.line : runtimeLine;
      const lineB = typeof b.line === 'number' ? b.line : runtimeLine;
      return Math.abs(lineA - runtimeLine) - Math.abs(lineB - runtimeLine);
    })[0];
  }

  private functionScopeKey(relativePath: string, functionName: string): string {
    return `${relativePath}::${functionName}`;
  }

  private toWorkspaceRelativePath(candidatePath: string): string | undefined {
    const workspaceRoot = this.workspaceFolder.uri.fsPath;
    const normalizedWorkspace = path.resolve(workspaceRoot);
    const normalizedCandidate = path.resolve(candidatePath);
    const relative = path.relative(normalizedWorkspace, normalizedCandidate);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return undefined;
    }

    return relative.split(path.sep).join('/');
  }

  private async createGraphFunction(
    moduleNodeId: string,
    functionNameRaw: string,
    inputsRaw: string[],
    outputsRaw: string[]
  ): Promise<void> {
    try {
      const moduleNode = this.nodeById.get(moduleNodeId);
      if (!moduleNode || moduleNode.type !== 'module' || !moduleNode.filePath || moduleNode.metadata?.external) {
        await this.postGraphEditResult({
          ok: false,
          message: 'Create failed: select a valid workspace module target.'
        });
        return;
      }

      const functionName = functionNameRaw.trim();
      if (!this.isValidPythonIdentifier(functionName)) {
        await this.postGraphEditResult({
          ok: false,
          message: `Create failed: invalid function name "${functionNameRaw}".`
        });
        return;
      }

      const inputs = inputsRaw
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .filter((value) => this.isValidPythonIdentifier(value));
      const outputs = outputsRaw.map((value) => value.trim()).filter((value) => value.length > 0);

      const source = await this.readWorkspaceFile(moduleNode.filePath);
      const defRegex = new RegExp(`^\\s*def\\s+${this.escapeRegExp(functionName)}\\s*\\(`, 'm');
      if (defRegex.test(source)) {
        await this.postGraphEditResult({
          ok: false,
          message: `Create failed: function ${functionName} already exists in ${moduleNode.filePath}.`
        });
        return;
      }

      const argsSignature = inputs.join(', ');
      const outputLine = outputs.length > 0 ? `    # Outputs: ${outputs.join(', ')}\n` : '';
      const stub = [
        `def ${functionName}(${argsSignature}):`,
        '    """Auto-generated by FlowDE graph editing."""',
        outputLine.trimEnd(),
        `    raise NotImplementedError("Implement ${functionName}")`
      ]
        .filter((line) => line.length > 0)
        .join('\n');

      const nextSource = `${source.replace(/\s*$/, '')}\n\n${stub}\n`;
      await this.writeWorkspaceFile(moduleNode.filePath, nextSource);
      await this.refreshGraph();

      await this.postGraphEditResult({
        ok: true,
        message: `Created function ${functionName} in ${moduleNode.filePath}.`
      });
    } catch (error) {
      await this.postGraphEditResult({
        ok: false,
        message: `Create failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  private async connectGraphNodes(sourceNodeId: string, targetNodeId: string): Promise<void> {
    try {
      const sourceNode = this.nodeById.get(sourceNodeId);
      const targetNode = this.nodeById.get(targetNodeId);

      if (!sourceNode || sourceNode.type !== 'function' || !sourceNode.filePath || typeof sourceNode.line !== 'number') {
        await this.postGraphEditResult({
          ok: false,
          message: 'Connect failed: source must be a concrete function node.'
        });
        return;
      }

      if (!targetNode || targetNode.type !== 'function') {
        await this.postGraphEditResult({
          ok: false,
          message: 'Connect failed: target must be a function node.'
        });
        return;
      }

      const sourceText = await this.readWorkspaceFile(sourceNode.filePath);
      const block = this.findFunctionBlock(sourceText, sourceNode.name, sourceNode.line);
      if (!block) {
        await this.postGraphEditResult({
          ok: false,
          message: `Connect failed: source function block not found for ${sourceNode.name}. Graph may be stale.`
        });
        return;
      }

      const lines = sourceText.split('\n');
      const blockLines = lines.slice(block.start, block.end);
      const callRegex = new RegExp(`\\b${this.escapeRegExp(targetNode.name)}\\s*\\(`);
      if (blockLines.some((line) => callRegex.test(line))) {
        await this.postGraphEditResult({
          ok: false,
          message: `Connect skipped: ${sourceNode.name} already calls ${targetNode.name}.`
        });
        return;
      }

      let insertAt = block.end;
      for (let index = block.start + 1; index < block.end; index += 1) {
        const trimmed = lines[index].trim();
        if (trimmed.startsWith('return ')) {
          insertAt = index;
          break;
        }
      }

      lines.splice(insertAt, 0, `${block.bodyIndentPrefix}${targetNode.name}()  # Connected via FlowDE graph`);
      await this.writeWorkspaceFile(sourceNode.filePath, lines.join('\n'));
      await this.refreshGraph();

      await this.postGraphEditResult({
        ok: true,
        message: `Connected ${sourceNode.name} -> ${targetNode.name} in ${sourceNode.filePath}.`
      });
    } catch (error) {
      await this.postGraphEditResult({
        ok: false,
        message: `Connect failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  private async renameGraphNode(nodeId: string, newNameRaw: string): Promise<void> {
    try {
      const node = this.nodeById.get(nodeId);
      if (!node) {
        await this.postGraphEditResult({ ok: false, message: 'Rename failed: selected node no longer exists.' });
        return;
      }

      if (node.type === 'module') {
        await this.postGraphEditResult({
          ok: false,
          message: 'Rename failed: module renaming is not enabled yet.'
        });
        return;
      }

      const newName = newNameRaw.trim();
      if (!this.isValidPythonIdentifier(newName)) {
        await this.postGraphEditResult({ ok: false, message: `Rename failed: invalid identifier "${newNameRaw}".` });
        return;
      }

      if (newName === node.name) {
        await this.postGraphEditResult({ ok: false, message: 'Rename skipped: new name matches current name.' });
        return;
      }

      if (node.filePath) {
        const definitionSource = await this.readWorkspaceFile(node.filePath);
        const definitionConflictRegex =
          node.type === 'function'
            ? new RegExp(`^\\s*def\\s+${this.escapeRegExp(newName)}\\s*\\(`, 'm')
            : node.type === 'class'
              ? new RegExp(`^\\s*class\\s+${this.escapeRegExp(newName)}\\b`, 'm')
              : new RegExp(`\\b${this.escapeRegExp(newName)}\\b`);

        if (definitionConflictRegex.test(definitionSource)) {
          await this.postGraphEditResult({
            ok: false,
            message: `Rename failed: ${newName} already exists in ${node.filePath}.`
          });
          return;
        }
      }

      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(this.workspaceFolder, '**/*.py'),
        PYTHON_EXCLUDE_GLOB
      );

      const matchRegex = new RegExp(`\\b${this.escapeRegExp(node.name)}\\b`, 'g');
      let changedFiles = 0;

      for (const fileUri of files) {
        const relativePath = this.toWorkspaceRelativePath(fileUri.fsPath);
        if (!relativePath) {
          continue;
        }

        const source = await this.readWorkspaceFile(relativePath);
        const next = source.replace(matchRegex, newName);
        if (next === source) {
          continue;
        }

        await this.writeWorkspaceFile(relativePath, next);
        changedFiles += 1;
      }

      if (changedFiles === 0) {
        await this.postGraphEditResult({ ok: false, message: 'Rename failed: no matching code references found.' });
        return;
      }

      await this.refreshGraph();
      await this.postGraphEditResult({
        ok: true,
        message: `Renamed ${node.name} -> ${newName} across ${changedFiles} file${changedFiles === 1 ? '' : 's'}.`
      });
    } catch (error) {
      await this.postGraphEditResult({
        ok: false,
        message: `Rename failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  private async moveGraphNode(nodeId: string, targetModuleNodeId: string): Promise<void> {
    try {
      const functionNode = this.nodeById.get(nodeId);
      const targetModuleNode = this.nodeById.get(targetModuleNodeId);

      if (
        !functionNode ||
        functionNode.type !== 'function' ||
        !functionNode.filePath ||
        typeof functionNode.line !== 'number'
      ) {
        await this.postGraphEditResult({
          ok: false,
          message: 'Move failed: selected node must be a top-level function with a source location.'
        });
        return;
      }

      if (typeof functionNode.metadata?.classNodeId === 'string') {
        await this.postGraphEditResult({
          ok: false,
          message: 'Move failed: moving class methods is not enabled yet.'
        });
        return;
      }

      if (
        !targetModuleNode ||
        targetModuleNode.type !== 'module' ||
        !targetModuleNode.filePath ||
        targetModuleNode.metadata?.external
      ) {
        await this.postGraphEditResult({ ok: false, message: 'Move failed: choose a valid workspace target module.' });
        return;
      }

      if (functionNode.filePath === targetModuleNode.filePath) {
        await this.postGraphEditResult({ ok: false, message: 'Move skipped: function is already in that module.' });
        return;
      }

      const sourceText = await this.readWorkspaceFile(functionNode.filePath);
      const targetText = await this.readWorkspaceFile(targetModuleNode.filePath);

      const block = this.findFunctionBlock(sourceText, functionNode.name, functionNode.line);
      if (!block) {
        await this.postGraphEditResult({
          ok: false,
          message: `Move failed: could not locate ${functionNode.name} in ${functionNode.filePath}.`
        });
        return;
      }

      const duplicateRegex = new RegExp(`^\\s*def\\s+${this.escapeRegExp(functionNode.name)}\\s*\\(`, 'm');
      if (duplicateRegex.test(targetText)) {
        await this.postGraphEditResult({
          ok: false,
          message: `Move failed: ${functionNode.name} already exists in ${targetModuleNode.filePath}.`
        });
        return;
      }

      const sourceLines = sourceText.split('\n');
      const movedLines = sourceLines.slice(block.start, block.end);
      sourceLines.splice(block.start, block.end - block.start);
      const nextSourceText = sourceLines.join('\n').replace(/\n{3,}/g, '\n\n');

      const movedBlock = movedLines.join('\n').replace(/\s*$/, '');
      const nextTargetText = `${targetText.replace(/\s*$/, '')}\n\n${movedBlock}\n`;

      await this.writeWorkspaceFile(functionNode.filePath, nextSourceText);
      await this.writeWorkspaceFile(targetModuleNode.filePath, nextTargetText);
      await this.refreshGraph();

      await this.postGraphEditResult({
        ok: true,
        message: `Moved ${functionNode.name} from ${functionNode.filePath} to ${targetModuleNode.filePath}.`
      });
    } catch (error) {
      await this.postGraphEditResult({
        ok: false,
        message: `Move failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  private async postGraphEditResult(outcome: GraphEditOutcome): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'graphEditResult',
      ...outcome
    });
  }

  private async readWorkspaceFile(relativePath: string): Promise<string> {
    const absolutePath = path.join(this.workspaceFolder.uri.fsPath, relativePath);
    return fs.readFile(absolutePath, 'utf8');
  }

  private async writeWorkspaceFile(relativePath: string, content: string): Promise<void> {
    const absolutePath = path.join(this.workspaceFolder.uri.fsPath, relativePath);
    await fs.writeFile(absolutePath, content, 'utf8');
  }

  private isValidPythonIdentifier(name: string): boolean {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return false;
    }

    return !PYTHON_KEYWORDS.has(name.toLowerCase());
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private findFunctionBlock(
    source: string,
    functionName: string,
    preferredLine?: number
  ): PythonFunctionBlock | undefined {
    const lines = source.split('\n');
    const matcher = new RegExp(`^(\\s*)def\\s+${this.escapeRegExp(functionName)}\\s*\\(`);
    const candidates: Array<{ lineIndex: number; indentPrefix: string }> = [];

    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(matcher);
      if (!match) {
        continue;
      }

      candidates.push({
        lineIndex: index,
        indentPrefix: match[1]
      });
    }

    if (candidates.length === 0) {
      return undefined;
    }

    let selected = candidates[0];
    if (typeof preferredLine === 'number') {
      const preferredIndex = Math.max(0, preferredLine - 1);
      selected = [...candidates].sort(
        (a, b) => Math.abs(a.lineIndex - preferredIndex) - Math.abs(b.lineIndex - preferredIndex)
      )[0];
    }

    const indentPrefix = selected.indentPrefix;
    const indentLength = indentPrefix.length;
    const indentUnit = indentPrefix.includes('\t') ? '\t' : '    ';
    let end = lines.length;

    for (let index = selected.lineIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const leadingWhitespace = line.match(/^\s*/)?.[0] ?? '';
      if (leadingWhitespace.length <= indentLength && !trimmed.startsWith('#')) {
        end = index;
        break;
      }
    }

    return {
      start: selected.lineIndex,
      end,
      indentPrefix,
      bodyIndentPrefix: `${indentPrefix}${indentUnit}`
    };
  }

  private async navigateToNode(nodeId: string): Promise<void> {
    const node = this.nodeById.get(nodeId);
    if (!node || !node.filePath || typeof node.line !== 'number') {
      return;
    }

    const targetUri = vscode.Uri.joinPath(this.workspaceFolder.uri, node.filePath);
    const document = await vscode.workspace.openTextDocument(targetUri);
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.One
    });

    const lineNumber = Math.max(node.line - 1, 0);
    const position = new vscode.Position(lineNumber, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }

  private async postGraphData(graphData: GraphData): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'graphData',
      payload: graphData
    });
  }

  private getWebviewHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'styles.css'));
    const nonce = createNonce();

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <link rel="stylesheet" href="${styleUri}" />
    <title>FlowDE Graph</title>
  </head>
  <body>
    <div class="shell">
      <header class="toolbar">
        <div class="title-group">
          <h1>FlowDE</h1>
          <p id="subtitle">Code graph</p>
        </div>
        <div class="toolbar-actions">
          <button id="layout-btn" type="button">Layout: Clustered</button>
          <button id="fit-btn" type="button">Fit</button>
          <button id="zoom-out-btn" type="button" aria-label="Zoom out">-</button>
          <button id="zoom-reset-btn" type="button">100%</button>
          <button id="zoom-in-btn" type="button" aria-label="Zoom in">+</button>
          <button id="refresh-btn" type="button">Refresh</button>
        </div>
      </header>
      <section class="status-row">
        <span id="status">Initializing graph view...</span>
      </section>
      <main class="workspace-layout">
        <aside class="flow-sidebar" aria-label="Flow sidebar">
          <div class="flow-sidebar-header">
            <h2>Flows</h2>
            <span id="flow-meta">0 discovered</span>
          </div>
          <div class="navigation-panel" aria-label="Navigation guide">
            <h3>Navigate</h3>
            <div class="navigation-actions">
              <button id="nav-overview-btn" type="button">Overview Mode</button>
              <button id="nav-follow-selection-btn" type="button">Follow Selection</button>
              <button id="nav-reset-btn" type="button">Reset Navigation</button>
            </div>
            <p id="navigation-status" class="navigation-status">
              Overview Mode switches to module-level and fits the full graph.
            </p>
            <div class="navigation-shortcuts">
              <span><strong>Hotkeys:</strong> O overview, F fit, 0 reset zoom, Esc clear selection</span>
            </div>
            <div class="navigation-legend" aria-label="Node and edge meaning">
              <div class="navigation-legend-row"><strong>Module</strong><span>file-level container</span></div>
              <div class="navigation-legend-row"><strong>Class</strong><span>object scope and methods</span></div>
              <div class="navigation-legend-row"><strong>Function</strong><span>callable execution step</span></div>
              <div class="navigation-legend-row"><strong>Variable</strong><span>state/value node</span></div>
              <div class="navigation-legend-row"><strong>Call edge</strong><span>function invokes function</span></div>
              <div class="navigation-legend-row"><strong>Dependency edge</strong><span>import/reference link</span></div>
              <div class="navigation-legend-row"><strong>Data-flow edge</strong><span>value transformation path</span></div>
              <div class="navigation-legend-row"><strong>Execution edge</strong><span>runtime trace transition</span></div>
            </div>
          </div>
          <div class="focus-panel" aria-label="Graph focus controls">
            <h3>Focus</h3>
            <label class="focus-control">
              <span>Selected file</span>
              <select id="focus-file">
                <option value="all">All files</option>
              </select>
            </label>
            <label class="focus-toggle">
              <input id="focus-neighborhood" type="checkbox" />
              <span>Neighborhood only</span>
            </label>
            <label class="focus-control">
              <span>Dependency traversal</span>
              <select id="dependency-direction">
                <option value="both" selected>Upstream + downstream</option>
                <option value="upstream">Upstream only</option>
                <option value="downstream">Downstream only</option>
              </select>
            </label>
            <label class="focus-control">
              <span>Hop depth</span>
              <div class="focus-slider-row">
                <input id="dependency-hops" type="range" min="1" max="8" step="1" value="3" />
                <span id="dependency-hops-value">3</span>
              </div>
            </label>
            <p id="dependency-status" class="dependency-status">Select a node to analyze dependency impact.</p>
            <button id="focus-clear-btn" type="button">Clear focus</button>
          </div>
          <div class="layer-panel" aria-label="Graph layer controls">
            <h3>Graph Layers</h3>
            <label class="focus-toggle">
              <input id="layer-structural" type="checkbox" checked />
              <span>Structural</span>
            </label>
            <label class="focus-toggle">
              <input id="layer-dependency" type="checkbox" checked />
              <span>Dependency</span>
            </label>
            <label class="focus-toggle">
              <input id="layer-dataflow" type="checkbox" checked />
              <span>Data Flow</span>
            </label>
            <label class="focus-toggle">
              <input id="layer-execution" type="checkbox" />
              <span>Execution</span>
            </label>
          </div>
          <div class="abstraction-panel" aria-label="Graph abstraction controls">
            <h3>Abstraction</h3>
            <label class="focus-control">
              <span>Level</span>
              <select id="abstraction-level">
                <option value="system">System (modules)</option>
                <option value="function" selected>Function (modules + functions)</option>
                <option value="detail">Detail (modules + functions + variables)</option>
              </select>
            </label>
            <label class="focus-toggle">
              <input id="abstraction-auto" type="checkbox" checked />
              <span>Auto by zoom</span>
            </label>
            <p id="abstraction-status" class="abstraction-status">Auto mode: Function level.</p>
          </div>
          <div class="reduction-panel" aria-label="Smart graph reduction">
            <h3>Smart Reduction</h3>
            <label class="focus-toggle">
              <input id="collapse-functions" type="checkbox" />
              <span>Collapse internal functions</span>
            </label>
            <label class="focus-toggle">
              <input id="collapse-libraries" type="checkbox" checked />
              <span>Collapse libraries</span>
            </label>
            <p id="reduction-hint" class="reduction-hint">Double-click modules to expand on demand.</p>
          </div>
          <div class="execution-panel" aria-label="Execution controls">
            <h3>Execution</h3>
            <div class="execution-actions">
              <button id="execution-start-btn" type="button">Run Trace</button>
              <button id="execution-stop-btn" type="button" disabled>Stop</button>
            </div>
            <div class="execution-playback" aria-label="Execution playback controls">
              <button id="execution-prev-btn" type="button" aria-label="Previous execution step">Prev</button>
              <button id="execution-play-btn" type="button" aria-label="Play execution">Play</button>
              <button id="execution-next-btn" type="button" aria-label="Next execution step">Next</button>
            </div>
            <div id="execution-status" class="execution-status">Idle</div>
            <div id="execution-node-state" class="execution-node-state">
              Run a trace to inspect inputs, outputs, and intermediate values.
            </div>
          </div>
          <div class="graph-edit-panel" aria-label="Graph editing controls">
            <h3>Edit Graph -> Code</h3>
            <div class="graph-edit-section">
              <h4>Create Function</h4>
              <label class="focus-control">
                <span>Module</span>
                <select id="edit-create-module">
                  <option value="">Select module</option>
                </select>
              </label>
              <label class="focus-control">
                <span>Name</span>
                <input id="edit-create-name" type="text" placeholder="new_function" />
              </label>
              <label class="focus-control">
                <span>Inputs (comma separated)</span>
                <input id="edit-create-inputs" type="text" placeholder="user_id, payload" />
              </label>
              <label class="focus-control">
                <span>Outputs (comma separated)</span>
                <input id="edit-create-outputs" type="text" placeholder="result" />
              </label>
              <button id="edit-create-btn" type="button">Create Function Node</button>
            </div>
            <div class="graph-edit-section">
              <h4>Connect Nodes</h4>
              <label class="focus-control">
                <span>Source Function</span>
                <select id="edit-connect-source">
                  <option value="">Select source</option>
                </select>
              </label>
              <label class="focus-control">
                <span>Target Function</span>
                <select id="edit-connect-target">
                  <option value="">Select target</option>
                </select>
              </label>
              <button id="edit-connect-btn" type="button">Connect (Generate Call)</button>
            </div>
            <div class="graph-edit-section">
              <h4>Rename Selected Node</h4>
              <label class="focus-control">
                <span>New Name</span>
                <input id="edit-rename-name" type="text" placeholder="renamed_symbol" />
              </label>
              <button id="edit-rename-btn" type="button">Rename Node in Code</button>
            </div>
            <div class="graph-edit-section">
              <h4>Move Selected Function</h4>
              <label class="focus-control">
                <span>Target Module</span>
                <select id="edit-move-module">
                  <option value="">Select module</option>
                </select>
              </label>
              <button id="edit-move-btn" type="button">Move Function</button>
            </div>
            <div id="graph-edit-status" class="graph-edit-status">Idle</div>
          </div>
          <div class="call-path-panel" aria-label="Call path exploration controls">
            <h3>Call Path Explorer</h3>
            <label class="focus-control">
              <span>Entry point</span>
              <select id="callpath-entry">
                <option value="">Select entry function</option>
              </select>
            </label>
            <label class="focus-control">
              <span>Max depth</span>
              <div class="focus-slider-row">
                <input id="callpath-depth" type="range" min="2" max="14" step="1" value="8" />
                <span id="callpath-depth-value">8</span>
              </div>
            </label>
            <div class="call-path-actions">
              <button id="callpath-run-btn" type="button">Explore Paths</button>
              <button id="callpath-clear-btn" type="button">Clear</button>
            </div>
            <div id="callpath-status" class="callpath-status">Auto mode: discovering broad flow patterns.</div>
          </div>
          <div class="dataflow-panel" aria-label="Data flow exploration controls">
            <h3>Data Flow Explorer</h3>
            <label class="focus-control">
              <span>Source node</span>
              <select id="dataflow-source">
                <option value="">Select source node</option>
              </select>
            </label>
            <label class="focus-control">
              <span>Direction</span>
              <select id="dataflow-direction">
                <option value="forward" selected>Forward</option>
                <option value="backward">Backward</option>
                <option value="both">Both</option>
              </select>
            </label>
            <label class="focus-control">
              <span>Max hops</span>
              <div class="focus-slider-row">
                <input id="dataflow-hops" type="range" min="1" max="10" step="1" value="4" />
                <span id="dataflow-hops-value">4</span>
              </div>
            </label>
            <div class="call-path-actions">
              <button id="dataflow-run-btn" type="button">Trace Data Flow</button>
              <button id="dataflow-clear-btn" type="button">Clear</button>
            </div>
            <div id="dataflow-status" class="dataflow-status">Select a source node to trace data transformations.</div>
          </div>
          <div class="node-inspector-panel" aria-label="Node inspector">
            <h3>Selection</h3>
            <div id="node-inspector" class="node-inspector">Click a node to inspect dependencies.</div>
            <button id="open-source-btn" type="button" disabled>Open source</button>
          </div>
          <div class="flow-controls" aria-label="Flow controls">
            <label class="flow-control">
              <span>Min steps</span>
              <select id="flow-min-length">
                <option value="1">1+</option>
                <option value="2" selected>2+</option>
                <option value="3">3+</option>
                <option value="4">4+</option>
                <option value="5">5+</option>
              </select>
            </label>
            <label class="flow-control">
              <span>Min confidence</span>
              <div class="flow-slider-row">
                <input id="flow-confidence" type="range" min="0" max="100" step="5" value="0" />
                <span id="flow-confidence-value">0%</span>
              </div>
            </label>
            <label class="flow-control">
              <span>Module</span>
              <select id="flow-module">
                <option value="all">All modules</option>
              </select>
            </label>
            <button id="flow-clear-btn" type="button">Clear highlight</button>
          </div>
          <ul id="flow-list" class="flow-list"></ul>
          <div class="flow-steps-panel">
            <div class="flow-steps-header">
              <h3>Flow Steps</h3>
              <div class="flow-playback" aria-label="Flow playback controls">
                <button id="flow-prev-btn" type="button" aria-label="Previous step">Prev</button>
                <button id="flow-play-btn" type="button" aria-label="Play flow">Play</button>
                <button id="flow-next-btn" type="button" aria-label="Next step">Next</button>
              </div>
            </div>
            <ol id="flow-steps" class="flow-steps"></ol>
            <div class="flow-explain-panel">
              <h3>Explain</h3>
              <div id="flow-explain" class="flow-explain"></div>
            </div>
          </div>
        </aside>
        <section class="graph-stage">
          <div id="graph-canvas" aria-label="FlowDE graph"></div>
          <aside class="minimap" aria-label="Graph overview">
            <div class="minimap-title">Overview</div>
            <canvas id="minimap-canvas" width="220" height="140"></canvas>
          </aside>
          <div class="legend-inline" aria-label="Graph legend">
            <span class="legend-item"><span class="legend-dot module"></span>Module</span>
            <span class="legend-item"><span class="legend-dot class"></span>Class</span>
            <span class="legend-item"><span class="legend-dot function"></span>Function</span>
            <span class="legend-item"><span class="legend-dot variable"></span>Variable</span>
            <span class="legend-item"><span class="legend-dot external"></span>External</span>
            <span class="legend-item"><span class="legend-edge call"></span>Call</span>
            <span class="legend-item"><span class="legend-edge dependency"></span>Dependency</span>
            <span class="legend-item"><span class="legend-edge dataflow"></span>Data Flow</span>
            <span class="legend-item"><span class="legend-edge execution"></span>Execution</span>
          </div>
        </section>
      </main>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function resolveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
  if (activeEditorUri) {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeEditorUri);
    if (activeFolder) {
      return activeFolder;
    }
  }

  return vscode.workspace.workspaceFolders?.[0];
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
