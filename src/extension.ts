import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const root = vscode.workspace.rootPath || '';
const STATE_FILE = path.join(root, '.timer_state.json');
const LOCKOUT_HOOK = path.join(root, '.git', 'hooks', 'pre-commit');
const POSTCOMMIT_HOOK = path.join(root, '.git', 'hooks', 'post-commit');
const BRANCH_LIMITS: { [key: string]: number } = {
  main: 6 * 60,
  tutorial: 15 * 60,
  addPicture: 30 * 60,
  addDistance: 30 * 60
};

let timerInterval: NodeJS.Timeout | undefined;

interface TimerState {
  branch: string;
  elapsed: number;
  limit: number;
  startTime: number;
}

function getBranch(): string {
  try {
    return execSync('git branch --show-current', { cwd: root }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function loadState(): TimerState | null {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as TimerState;
  }
  return null;
}

function saveState(st: TimerState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(st));
}

function resetState(branch: string): TimerState {
  const limit = BRANCH_LIMITS[branch] || 30 * 60;
  return { branch, elapsed: 0, limit, startTime: Date.now() / 1000 };
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function installLockout() {
  const hook = `#!/bin/sh\necho \"⛔️ Timer expired—no more commits allowed.\"\nexit 1\n`;
  fs.writeFileSync(LOCKOUT_HOOK, hook);
  fs.chmodSync(LOCKOUT_HOOK, 0o755);
}

function installPostCommitHook(context: vscode.ExtensionContext) {
  const hook = `#!/bin/sh
echo "pause" > "${path.join(root, '.pause_timer')}"
git push origin
`;
  fs.writeFileSync(POSTCOMMIT_HOOK, hook, { mode: 0o755 });
}

async function onTimerFinished(statusBar: vscode.StatusBarItem, context: vscode.ExtensionContext) {
  // 1. stop the interval right away
  clearInterval(timerInterval!);
  statusBar.text = `$(check) 00:00`;

  // 2. show zero time and clear any pause file
  const pauseTimerPath = path.join(root, '.pause_timer');
  if (fs.existsSync(pauseTimerPath)) {
    fs.unlinkSync(pauseTimerPath);
  }
  // now show your modal exactly once
  await vscode.window.showErrorMessage(
    '⏰ Time’s up! Please stop coding for current task now. Do not commit any code, this timer will automatically commit all the code for you',
    { modal: true },
    'Ok'   
  );

  try {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt) throw new Error('Git extension not found');
    const gitApi = gitExt.exports.getAPI(1);
    const repo = gitApi.repositories[0];
    const branch = repo.state.HEAD!.name!;

    //Commit and push changes
    console.log('⏳ staging…');
    await repo.add([]); // Stage all changes
    console.log('✅ staged, now committing…');
    await repo.commit('Auto-commit: time expired', { all: true }); // Commit all changes
    console.log('✅ committed, now pushing…');
    await repo.push('origin', branch); // Push changes to the remote repository
    console.log('✅ pushed, now installing lockout hook…');
    installLockout(); // Install the lockout hook
    console.log('✅ lockout installed');
    vscode.window.showInformationMessage('✅ All your code has been committed automatically!');
  } catch (err: any) {
    // Log the error for debugging
    console.error('Error during auto-commit:', err);
    vscode.window.showErrorMessage(`Auto-commit failed: ${err.message}`);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.startTimer', async () => {
      // Show a pop-up window with task instructions
      const userResponse = await vscode.window.showInformationMessage(
        '📋 Please read the task instructions before starting. Click "Start" when ready.',
        { modal: true },
        'Start'
      );
      // If the user clicks "Start", proceed with starting the timer
    if (userResponse === 'Start') {
      const branch = getBranch();
      let st = loadState();
      if (!st || st.branch !== branch || st.elapsed >= st.limit) {
        st = resetState(branch);
      } else {
        st.startTime = Date.now() / 1000;
      }
      saveState(st);

      installPostCommitHook(context);

      timerInterval && clearInterval(timerInterval);
      timerInterval = setInterval(async () => {
        const now = Date.now() / 1000;
        const totalElapsed = Math.min(st.limit, st.elapsed + (now - st.startTime));
        const remaining = st.limit - totalElapsed;
        saveState({ ...st, elapsed: totalElapsed });
        statusBar.text = `$(clock) ${formatTime(remaining)}`;
        statusBar.show();

        // Check for the pause trigger file
        if (fs.existsSync(path.join(root, '.pause_timer'))) {
          fs.unlinkSync(path.join(root, '.pause_timer')); // Remove the trigger file
          timerInterval && clearInterval(timerInterval);
          await vscode.window.showWarningMessage('✅ You code has been pushed successfully, timer paused. Please click the start when you are ready to begin next task', { modal: true }, 'Ok');
          return;
        }

        if (remaining <= 300 && remaining > 299) {
          await vscode.window.showWarningMessage(
            '⚠️ Only 5 minutes remaining!',
            { modal: true },
            'OK'
          );
        }
        if (remaining <= 0) {
          await onTimerFinished(statusBar, context);
        }
      }, 1000);
    }
  })
);

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.pauseTimer', () => {
      const st = loadState();
      if (!st) return vscode.window.showInformationMessage('Timer not started.');
      const now = Date.now() / 1000;
      const totalElapsed = Math.min(st.limit, st.elapsed + (now - st.startTime));
      saveState({ ...st, elapsed: totalElapsed });
      timerInterval && clearInterval(timerInterval);
      statusBar.text = `$(clock) ${formatTime(st.limit - totalElapsed)}`;
      statusBar.show();
      vscode.window.showInformationMessage(`⏸️ Timer paused. ${formatTime(st.limit - totalElapsed)} remaining.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.showStatus', () => {
      const st = loadState();
      if (!st) return vscode.window.showInformationMessage('Timer not started.');
      const now = Date.now() / 1000;
      const totalElapsed = Math.min(st.limit, st.elapsed + (now - st.startTime));
      const remaining = st.limit - totalElapsed;
      const running = !!timerInterval;
      vscode.window.showInformationMessage(
        `[${st.branch}] ${running ? 'Running' : 'Paused'} | Remaining: ${formatTime(remaining)}`
      );
    })
  );
}

export function deactivate() {
  timerInterval && clearInterval(timerInterval);
}
