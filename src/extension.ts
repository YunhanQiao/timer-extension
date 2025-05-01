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
let currentState: TimerState;

interface TimerState {
  branch: string;
  elapsed: number;
  limit: number;
  startTime: number;
  task: number;
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
    branch: st.branch!,
    elapsed: st.elapsed ?? 0,
    limit: st.limit ?? (BRANCH_LIMITS[st.branch!] ?? 30 * 60),
    startTime: st.startTime ?? Date.now() / 1000,
    task: st.task ?? 1
  };
}

function saveState(st: TimerState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(st));
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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
 echo "pause" > "${path.join(root, '.pause_timer')}"
 git push origin
`;
  fs.writeFileSync(POSTCOMMIT_HOOK, hook, { mode: 0o755 });
}

async function onTimerFinished(statusBar: vscode.StatusBarItem) {
  clearInterval(timerInterval!);
  statusBar.text = `$(check) 00:00`;

  const pausePath = path.join(root, '.pause_timer');
  if (fs.existsSync(pausePath)) fs.unlinkSync(pausePath);

  await vscode.window.showErrorMessage(
    '⏰ Time’s up! Please stop coding for the current task now. Do not commit any code – the timer will auto-commit everything for you.',
    { modal: true },
    'Ok'
  );

  try {
    const gitExt = vscode.extensions.getExtension<any>('vscode.git');
    if (!gitExt) throw new Error('Git extension not found');
    const gitApi = gitExt.exports.getAPI(1);
    const repo = gitApi.repositories[0];
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

async function promptForStart(task: number): Promise<boolean> {
  await vscode.window.showInformationMessage(
    `📋 Please read the instructions for Task ${task} in Canvas. When you’re ready, type "Start task ${task}" exactly below.`,
    { modal: true }
  );

  const target = `Start task ${task}`;
  while (true) {
    const input = await vscode.window.showInputBox({
      prompt: `Type "${target}" to begin Task ${task}`,
      placeHolder: target,
      ignoreFocusOut: true,
      validateInput: value => value === target ? null : `Please type exactly: ${target}`
    });
    if (input === target) return true;
    if (input === undefined) return false;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.startTimer', async () => {
      const branch = getBranch();
      const maxTasks = ['addDistance', 'addPicture'].includes(branch) ? 3 : 1;
      const now = Date.now() / 1000;

      let st = loadState();
      if (!st || st.branch !== branch) {
        st = { branch, elapsed: 0, limit: BRANCH_LIMITS[branch] || 30 * 60, startTime: now, task: 1 };
      } else {
        st.startTime = now;
      }
      currentState = st;
      saveState(st);

      if (st.task > maxTasks) {
        await vscode.window.showInformationMessage(
          '🎉 Congratulations! You have completed all tasks for this feature. Your code has been pushed. Please stop recording your video, return to Canvas to provide a link to your recording, and then move on to the next lab item.',
          { modal: true }
        );
        return;
      }

      const ready = await promptForStart(st.task);
      if (!ready) return;

      installPostCommitHook();
      timerInterval && clearInterval(timerInterval);
      timerInterval = setInterval(async () => {
        const now = Date.now() / 1000;
        const totalElapsed = Math.min(st.limit, st.elapsed + (now - st.startTime));
        const remaining = st.limit - totalElapsed;
        saveState({ ...st, elapsed: totalElapsed });
        statusBar.text = `$(clock) ${formatTime(remaining)}`;
        statusBar.show();

        const pausePath = path.join(root, '.pause_timer');
        if (fs.existsSync(pausePath)) {
          fs.unlinkSync(pausePath);
          clearInterval(timerInterval!);

          st.task++;
          if (st.task > maxTasks) {
            await vscode.window.showInformationMessage(
              '🎉 All tasks complete! Your code has been pushed. Please stop recording your video, return to Canvas to provide a link to your recording, and then move on to the next lab item.',
              { modal: true }
            );
            return;
          }

          st.startTime = Date.now() / 1000;
          saveState(st);

          const again = await promptForStart(st.task);
          if (again) {
            await vscode.commands.executeCommand('extension.startTimer');
          }
          return;
        }

        if (remaining <= 300 && remaining > 299) {
          await vscode.window.showWarningMessage('⚠️ Only 5 minutes remaining!', { modal: true }, 'OK');
        }

        if (remaining <= 0) {
          await onTimerFinished(statusBar);
        }
      }, 1000);
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
