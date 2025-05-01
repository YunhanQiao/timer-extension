import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const root = vscode.workspace.rootPath || '';
const STATE_FILE = path.join(root, '.timer_state.json');
const LOCKOUT_HOOK = path.join(root, '.git', 'hooks', 'pre-commit');
const POSTCOMMIT_HOOK = path.join(root, '.git', 'hooks', 'post-commit');

const BRANCH_LIMITS: { [key: string]: number } = {
  main:        6 * 60,
  tutorial:   15 * 60,
  addPicture: 30 * 60,
  addDistance:30 * 60
};

let isTimerRunning = false;
let currentState: TimerState;

interface TimerState {
  branch:    string;
  elapsed:   number;
  limit:     number;
  startTime: number;
  task:      number;
}

function getBranch(): string {
  try {
    return execSync('git branch --show-current', { cwd: root }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function loadState(): TimerState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<TimerState>;
  return {
    branch:    st.branch!,
    elapsed:   st.elapsed   ?? 0,
    limit:     st.limit     ?? (BRANCH_LIMITS[st.branch!] ?? 30*60),
    startTime: st.startTime ?? Date.now() / 1000,
    task:      st.task      ?? 1
  };
}

function saveState(st: TimerState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(st));
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function installLockout() {
  const hook = `#!/bin/sh
echo "⛔️ Timer expired—no more commits allowed."
exit 1
`;
  fs.writeFileSync(LOCKOUT_HOOK, hook, { mode: 0o755 });
}

function installPostCommitHook() {
  const hook = `#!/bin/sh
echo "pause" > "${path.join(root,'.pause_timer')}"
git push origin
`;
  fs.writeFileSync(POSTCOMMIT_HOOK, hook, { mode: 0o755 });
}

async function promptForStart(label: string): Promise<boolean> {
  await vscode.window.showInformationMessage(
    `📋 Please read the instructions for ${label}. When you're ready, type "Start ${label}" exactly below.`,
    { modal: true }
  );

  const target = `Start ${label}`;
  while (true) {
    const input = await vscode.window.showInputBox({
      prompt: `Type "${target}" to begin ${label}`,
      placeHolder: target,
      ignoreFocusOut: true,
      validateInput: value => value === target ? null : `Please type exactly: ${target}`
    });
    if (input === target) return true;
    if (input === undefined) return false;
  }
}

async function onTimerFinished(statusBar: vscode.StatusBarItem) {
  isTimerRunning = false;
  statusBar.text = `$(clock) 00:00`;

  const pausePath = path.join(root, '.pause_timer');
  if (fs.existsSync(pausePath)) fs.unlinkSync(pausePath);

  await vscode.window.showErrorMessage(
    "⏰ Time's up! Please stop coding for the current task now. Do not commit any code – the timer will auto-commit everything for you.",
    { modal: true },
    'Ok'
  );

  try {
    const gitExt = vscode.extensions.getExtension<any>('vscode.git');
    if (!gitExt) throw new Error('Git extension not found');
    const gitApi = gitExt.exports.getAPI(1);
    const repo   = gitApi.repositories[0];
    const branch = repo.state.HEAD!.name!;

    await repo.add([]);
    await repo.commit(`Auto-commit: Task ${currentState.task} expired`, { all: true });
    await repo.push('origin', branch);
    installLockout();
    vscode.window.showInformationMessage('✅ All your code has been committed automatically!');
  } catch (err: any) {
    console.error('Error during auto-commit:', err);
    vscode.window.showErrorMessage(`Auto-commit failed: ${err.message}`);
  }
}

// Timer loop function that runs in the background
async function runTimerLoop(st: TimerState, statusBar: vscode.StatusBarItem, isWarmup: boolean, maxTasks: number) {
  isTimerRunning = true;
  
  while (isTimerRunning) {
    // Wait for 1 second
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const nowSec = Date.now() / 1000;
    const totalElapsed = Math.min(st.limit, st.elapsed + (nowSec - st.startTime));
    const remaining = st.limit - totalElapsed;
    
    // Update state and UI
    saveState({ ...st, elapsed: totalElapsed });
    statusBar.text = `$(clock) ${formatTime(remaining)}`;
    statusBar.show();
    
    // Check for pause file
    const pausePath = path.join(root, '.pause_timer');
    if (fs.existsSync(pausePath)) {
      fs.unlinkSync(pausePath);
      
      // Show confirmation that the current task was committed
      await vscode.window.showInformationMessage(
        `✅ Task ${st.task} has been committed and pushed successfully!`,
        { modal: true }
      );
      
      st.task++;
      if (st.task > maxTasks) {
        isTimerRunning = false;
        await vscode.window.showInformationMessage(
          '🎉 All tasks complete! Your code has been pushed. Return to Canvas to submit.',
          { modal: true }
        );
        break;
      }
      
      // Pause the timer while waiting for user input
      isTimerRunning = false;
      
      // Prompt for next task
      const nextLabel = isWarmup ? 'warm-up task' : `Task ${st.task}`;
      const again = await promptForStart(nextLabel);
      if (!again) {
        break;
      }
      
      // KEEP elapsed, reset startTime only
      // Store the current elapsed time before updating startTime
      const now = Date.now() / 1000;
      // Update elapsed time with time passed since last startTime
      st.elapsed = Math.min(st.limit, st.elapsed + (now - st.startTime));
      // Reset startTime for the new task
      st.startTime = now;
      saveState(st);
      installPostCommitHook();
      
      // Show remaining time instead of full limit
      const rem = st.limit - st.elapsed;
      statusBar.text = `$(clock) ${formatTime(rem)}`;
      statusBar.show();
      
      // Resume the timer for the next task
      isTimerRunning = true;
    }
    
    // Check time warnings and limits
    if (remaining <= 300 && remaining > 299) {
      await vscode.window.showWarningMessage('⚠️ Only 5 minutes remaining!', { modal: true }, 'OK');
    }
    
    if (remaining <= 0) {
      await onTimerFinished(statusBar);
      break;
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.startTimer', async () => {
      const branch   = getBranch();
      const isWarmup = branch === 'tutorial';
      const maxTasks = isWarmup
        ? 1
        : (['addDistance','addPicture'].includes(branch) ? 3 : 1);
      const now      = Date.now() / 1000;

      // Stop any existing timer
      isTimerRunning = false;

      // load or initialize state
      let st = loadState();
      if (!st || st.branch !== branch) {
        st = {
          branch,
          elapsed:   0,
          limit:     BRANCH_LIMITS[branch] ?? 30*60,
          startTime: now,
          task:      1
        };
      }
      currentState = st;
      saveState(st);

      // if already done
      if (st.task > maxTasks) {
        await vscode.window.showInformationMessage(
          '🎉 You\'ve completed all tasks! Your code is pushed - please return to Canvas to submit.',
          { modal: true }
        );
        return;
      }

      // Check for pause file first - handles resuming after a commit
      const pausePath = path.join(root, '.pause_timer');
      if (fs.existsSync(pausePath)) {
        fs.unlinkSync(pausePath);
        
        // Show confirmation that the previous task was committed
        await vscode.window.showInformationMessage(
          `✅ Task ${st.task} has been committed and pushed successfully!`,
          { modal: true }
        );
        
        st.task++;
        if (st.task > maxTasks) {
          await vscode.window.showInformationMessage(
            '🎉 All tasks complete! Your code has been pushed. Return to Canvas to submit.',
            { modal: true }
          );
          return;
        }
        
        // Prompt for next task
        const nextLabel = isWarmup ? 'warm-up task' : `Task ${st.task}`;
        const again = await promptForStart(nextLabel);
        if (!again) return;
        
        // Keep elapsed time, reset startTime only
        st.startTime = Date.now() / 1000;
        saveState(st);
      } else {
        // First prompt (only if no pause file exists)
        const label = isWarmup ? 'warm-up task' : `Task ${st.task}`;
        const ready = await promptForStart(label);
        if (!ready) return;
        
        // Reset timer for the very first task
        st.elapsed = 0;
        st.startTime = Date.now() / 1000;
        saveState(st);
      }

      statusBar.text = `$(clock) ${formatTime(st.limit - st.elapsed)}`;
      statusBar.show();
      installPostCommitHook();

      // Start the timer loop in a separate async function
      runTimerLoop(st, statusBar, isWarmup, maxTasks).catch(err => {
        console.error('Timer loop error:', err);
        vscode.window.showErrorMessage(`Timer error: ${err.message}`);
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.pauseTimer', () => {
      const st = loadState();
      if (!st) return vscode.window.showInformationMessage('Timer not started.');
      
      isTimerRunning = false;
      
      const now     = Date.now() / 1000;
      const elapsed = Math.min(st.limit, st.elapsed + (now - st.startTime));
      saveState({ ...st, elapsed });
      
      statusBar.text = `$(clock) ${formatTime(st.limit - elapsed)}`;
      statusBar.show();
      vscode.window.showInformationMessage(`⏸️ Timer paused. ${formatTime(st.limit - elapsed)} remaining.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.showStatus', () => {
      const st = loadState();
      if (!st) return vscode.window.showInformationMessage('Timer not started.');
      
      const now     = Date.now() / 1000;
      const elapsed = Math.min(st.limit, st.elapsed + (now - st.startTime));
      const remaining = st.limit - elapsed;
      
      vscode.window.showInformationMessage(
        `[${st.branch}] ${isTimerRunning ? 'Running' : 'Paused'} | Remaining: ${formatTime(remaining)}`
      );
    })
  );
}

export function deactivate() {
  isTimerRunning = false;
}