// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

let timerStatusBar: vscode.StatusBarItem;
let timerInterval: NodeJS.Timeout | undefined;
let remainingSeconds: number = 0;


// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Register the Start Timer command
    const startCmd = vscode.commands.registerCommand('extension.startTimer', async () => {
        // Prompt the user for a countdown duration (in minutes)
        const input = await vscode.window.showInputBox({ 
            prompt: 'Enter countdown duration in minutes', 
            validateInput: value => {
                return /^\d+$/.test(value) ? null : 'Please enter a valid number of minutes';
            }
        });
        if (!input) {
            return; // command was canceled
        }
        const minutes = parseInt(input);
        startCountdown(minutes);
    });
    context.subscriptions.push(startCmd);

    // Create a status bar item to display the timer (left alignment, priority 100)
    timerStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    timerStatusBar.command = 'extension.startTimer';  // optional: click to restart timer
    context.subscriptions.push(timerStatusBar);
}

function startCountdown(minutes: number) {
    // If a timer is already running, clear it first
    if (timerInterval) {
        clearInterval(timerInterval);
    }
    remainingSeconds = minutes * 60;
    updateStatusBarTime(remainingSeconds);   // initialize display

    timerStatusBar.show();  // make sure the status bar item is visible

    timerInterval = setInterval(async () => {
        remainingSeconds -= 1;
        updateStatusBarTime(remainingSeconds);

        if (remainingSeconds === 300) {
            // 5 minutes remaining -> show warning alert
            vscode.window.showWarningMessage(`⏳ Only 5 minutes left on the timer!`);
        }

        if (remainingSeconds <= 0) {
            // Time is up -> clear timer and trigger commit
            clearInterval(timerInterval!);
            timerInterval = undefined;
            await onTimerFinished();
        }
    }, 1000);
}


function updateStatusBarTime(seconds: number) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    const timeStr = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    timerStatusBar.text = `$(clock) ${timeStr}`;
}

async function onTimerFinished() {
    timerStatusBar.text = `$(check) 00:00`;  // indicate timer done (for UX)
    // Optionally, hide the status bar or keep it showing 0:00. We'll pause now.

    // Show a notification that the timer ended and committing is starting
    vscode.window.showInformationMessage("⏱ Time’s up! Auto-committing changes...");

    try {
        // Access the Git extension API
        const gitExt = vscode.extensions.getExtension('vscode.git');
        if (!gitExt) {
            throw new Error("Git extension not found");
        }
        const gitApi = gitExt.exports.getAPI(1);
        const repositories = gitApi.repositories;
        if (repositories.length === 0) {
            throw new Error("No Git repository open to commit.");
        }

        const repo = repositories[0];  // assuming a single repo workspace
        // Stage all changes (this adds tracked files; untracked files will remain untracked 
        // unless we explicitly add them)
        await repo.add([]);  // add all changes; passing an empty array stages everything
        // Commit with a default message
        const commitMessage = `Auto-commit: Countdown Timer finished at ${new Date().toLocaleTimeString()}`;
        await repo.commit(commitMessage, { all: true });  // 'all' stages tracked files&#8203;:contentReference[oaicite:8]{index=8}&#8203;:contentReference[oaicite:9]{index=9}

        // Push to remote (assuming the current branch has an upstream configured)
        await repo.push();
        vscode.window.showInformationMessage("✅ Changes committed and pushed to GitHub.");
    } catch (err: any) {
        console.error(err);
        vscode.window.showErrorMessage(`Auto-commit failed: ${err.message}`);
    }

    // Timer is finished; user will need to start it again manually for the next round
}


// This method is called when your extension is deactivated
export function deactivate() {}
