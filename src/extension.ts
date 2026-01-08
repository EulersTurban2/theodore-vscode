// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	console.log('Theodore extension is running');

	const disposable = vscode.commands.registerCommand('theodore.compileFile', () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const filePath = editor.document.fileName;
		compileTheodoreFile(filePath,context);
	});

	context.subscriptions.push(disposable);
}

function compileTheodoreFile(filePath: string, context:vscode.ExtensionContext) {
	const theodorePath = path.join(context.globalStorageUri.fsPath, 'theodore', 'Theodore.hs');

	exec(`stack runghc "${theodorePath}" check "${filePath}"`,(err,stdout,stderr) => {
		if(err) {
			vscode.window.showErrorMessage(stderr);
		} else {
			vscode.window.showInformationMessage(stdout || 'Theodore compiled successfully!');
		}
	});
}

// This method is called when your extension is deactivated
export function deactivate() {}
