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
  | { type: 'stopExecutionTrace' };

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

const TRACE_PREFIX = 'FLOWDE_TRACE:';

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
