import * as vscode from 'vscode';
import { exec, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';

let webviewPanel: vscode.WebviewPanel | undefined;
let outputChannel: vscode.OutputChannel;
let currentProcess: ChildProcess | undefined;

export function activate(context: vscode.ExtensionContext) {
    // Create an output channel to see the raw output from the Theodore CLI
    outputChannel = vscode.window.createOutputChannel("Theodore CLI");
    context.subscriptions.push(outputChannel);

    let compileCommand = vscode.commands.registerCommand('theodore.compileFile', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        // Ensure the file is saved so the CLI sees the latest changes
        await editor.document.save();

        const filePath = editor.document.uri.fsPath;

        const platform = os.platform();
        let executableName = 'theodore-cli';

        if (platform === 'win32') {
            executableName = 'theodore-cli-win.exe';
        } else if (platform === 'darwin') {
            executableName = 'theodore-cli-mac';
        }

        const theodoreExe = path.join(context.extensionPath, 'bin', executableName);

        outputChannel.appendLine(`[INFO] Compiling: ${filePath}`);

        // Kill previous process if it's still running to prevent hangs
        if (currentProcess) {
            outputChannel.appendLine(`[INFO] Terminating previous compilation process (PID: ${currentProcess.pid}).`);
            currentProcess.kill(); // Send SIGTERM to the previous process
        }

        // Store the new process in a local variable first
        const newProcess = exec(`"${theodoreExe}" "${filePath}"`, { timeout: 15000 }, (error, stdout, stderr) => {
            // This callback is for 'newProcess'. If 'currentProcess' is still 'newProcess',
            // then this is the active process finishing, so we can clear it.
            if (currentProcess === newProcess) {
                currentProcess = undefined;
            }
            // Log all output to the channel for debugging
            if (stdout) outputChannel.appendLine(`[STDOUT] ${stdout}`);
            if (stderr) {
                outputChannel.appendLine(`[STDERR] ${stderr}`);
            }

            // Always show the output channel if there's any output or an error
            if (stdout || stderr || error) {
                outputChannel.show(true);
            }

            if (error && !stdout) {
                vscode.window.showErrorMessage("Theodore Engine Crashed. See output channel for details.");
                return;
            }

            try {
                const currentLine = editor.selection.active.line + 1;
                const theodoreState = parseTheodoreOutput(stdout, currentLine);
                updateWebview(context, theodoreState, editor);
            } catch (e) {
                vscode.window.showErrorMessage("Failed to parse Theodore output. See output channel for details.");
                outputChannel.show(true);
            }
        });

        // Now assign the new process to the global currentProcess
        currentProcess = newProcess;
    });

    context.subscriptions.push(compileCommand);

    // Sync cursor movement with the webview if it is open
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(e => {
        if (webviewPanel && e.textEditor === vscode.window.activeTextEditor) {
            const currentLine = e.selections[0].active.line + 1;
            webviewPanel.webview.postMessage({ command: 'updateCursor', line: currentLine });
        }
    }));
}

function updateWebview(context: vscode.ExtensionContext, state: any, editor: vscode.TextEditor) {
    if (!webviewPanel) {
        // Create the side-panel if it doesn't exist
        webviewPanel = vscode.window.createWebviewPanel(
            'theodoreView',
            'Theodore Goals',
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );

        webviewPanel.onDidDispose(() => {
            webviewPanel = undefined;
        });
    }

    const currentLine = editor.selection.active.line + 1;
    // Always update the entire HTML content with the latest state.
    // This ensures a full refresh and eliminates potential issues with postMessage updates.
    webviewPanel.webview.html = getWebviewContent(state, currentLine);
    webviewPanel.reveal(vscode.ViewColumn.Beside, true);
}

/**
 * Helper to strip ANSI escape codes from string output.
 */
function stripAnsi(str: string): string {
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

/**
 * Robustly parses Theodore CLI output, supporting both JSON and raw text formats.
 */
function parseTheodoreOutput(output: string, line: number): any {
    const cleanOutput = stripAnsi(output);

    // Attempt 1: Parse as JSON if the CLI outputs it
    const jsonMatch = cleanOutput.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            return JSON.parse(jsonMatch[0]);
        } catch (e) {
            outputChannel.appendLine(`[WARN] Found JSON-like block but failed to parse: ${e}`);
        }
    }

    // Attempt 2: Fallback to manual parsing for the text format provided
    const latexTree = extractLatexProofTree(output);
    
    // Extract context (assumptions marked with bullets)
    const contextSet = new Set<string>();
    const contextMatches = cleanOutput.matchAll(/•\s*(.*)/g);
    for (const match of contextMatches) {
        contextSet.add(match[1].trim());
    }

    const context = Array.from(contextSet);

    // Extract goal (the line containing ⊢)
    const goalMatch = cleanOutput.match(/⊢\s*(.*)/);
    const goal = goalMatch ? goalMatch[1].trim() : "Goal found/Complete";

    return {
        states: [{ line, context, goal }],
        latexTree: latexTree || ""
    };
}

function extractLatexProofTree(output: string): string | undefined {
    const latexRegex = /\\begin\{prooftree\}[\s\S]*?\\end\{prooftree\}/;
    const match = output.match(latexRegex);
    return match ? match[0] : undefined;
}

function getWebviewContent(state: any, initialLine: number): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Theodore State</title>
    <script>
        window.MathJax = {
            tex: {
                packages: {'[+]': ['bussproofs']},
                inlineMath: [['$', '$'], ['\\(', '\\)']]
            },
            loader: {
                load: ['[tex]/bussproofs']
            }
        };
    </script>
    <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
    <style>
        body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); }
        .panel { background: var(--vscode-editor-inactiveSelectionBackground); padding: 10px; margin-bottom: 10px; border-radius: 5px; }
        .error { color: var(--vscode-errorForeground); font-weight: bold; }
        .latex-tree { overflow-x: auto; }
        .copy-container { margin-top: 10px; }
        textarea { 
            width: 100%; height: 80px; font-family: var(--vscode-editor-font-family); 
            background: var(--vscode-input-background); color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border); border-radius: 3px; resize: vertical;
        }
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground); }
    </style>
</head>
<body>
    <h2>Proof State</h2>
    <div id="state-container" class="panel">
        <em>Compile to see state.</em>
    </div>

    <h2>LaTeX Tree</h2>
    <div id="latex-container" class="panel latex-tree">
        ${state.latexTree ? '<div id="latex-content"></div>' : '<em>No tree generated.</em>'}
    </div>

    <h2>LaTeX Source</h2>
    <div class="panel copy-container">
        <textarea id="latex-raw" readonly></textarea>
        <button id="copy-button">Copy to Clipboard</button>
    </div>

    <script>
        let proofStates = ${JSON.stringify(state.states || [])};
        let errorState = ${JSON.stringify(state.error || null)};
        let latexTree = ${JSON.stringify(state.latexTree || "")};
        let lastLine = ${initialLine};

        window.addEventListener('message', event => {
            const message = event.data; // The JSON data from the extension
            if (message.command === 'updateCursor') { // Only handle cursor updates
                lastLine = message.line;
                renderStateForLine(message.line);
            }
        });

        function renderStateForLine(line) {
            const container = document.getElementById('state-container');
            
            // If the cursor is on the line where an error occurred
            if (errorState && errorState.line === line) {
                container.innerHTML = '<div class="error">❌ ' + errorState.message + '</div>';
                return;
            }

            // Find the most relevant state up to the current line
            const currentState = proofStates.slice().reverse().find(s => s.line <= line);
            
            if (currentState) {
                const formattedContext = currentState.context.map(item => {
                    // Separate the logical expression from the label in parentheses
                    const lastParenIndex = item.lastIndexOf('(');
                    if (lastParenIndex > -1 && item.endsWith(')')) {
                        const logicalPart = item.substring(0, lastParenIndex).trim();
                        const labelPart = item.substring(lastParenIndex).trim();
                        return '$' + logicalPart + '$ ' + labelPart;
                    }
                    return '$' + item + '$';
                }).join(', ');

                container.innerHTML = '<strong>Context:</strong> ' + (formattedContext || 'None') + 
                                      '<br><br><strong>Goal:</strong> $' + currentState.goal + '$';
                
                if (window.MathJax && window.MathJax.typesetPromise) {
                    window.MathJax.typesetPromise([container]);
                }
            } else {
                container.innerHTML = '<em>No state available for this line.</em>';
            }
        }

        // Render LaTeX tree using MathJax if available
        window.addEventListener('load', () => {
            if (latexTree) {
                const rawArea = document.getElementById('latex-raw');
                if (rawArea) { rawArea.value = latexTree; }

                const target = document.getElementById('latex-content');
                if (target) {
                    target.innerHTML = '$$' + latexTree + '$$';
                    if (window.MathJax && window.MathJax.typeset) { window.MathJax.typeset(); }
                }
            }
            renderStateForLine(lastLine);
        });

        document.getElementById('copy-button')?.addEventListener('click', () => {
            const rawArea = document.getElementById('latex-raw');
            if (rawArea) {
                rawArea.select();
                document.execCommand('copy');
                const btn = document.getElementById('copy-button');
                if (btn) { btn.innerText = 'Copied!'; setTimeout(() => btn.innerText = 'Copy to Clipboard', 2000); }
            }
        });
    </script>
</body>
</html>`;
}