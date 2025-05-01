import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const root            = vscode.workspace.rootPath || '';
const STATE_FILE      = path.join(root, '.timer_state.json');
const LOCKOUT_HOOK    = path.join(root, '.git', 'hooks', 'pre-commit');
const POSTCOMMIT_HOOK = path.join(root, '.git', 'hooks', 'post-commit');

const BRANCH_LIMITS: { [key: string]: number } = {
  main:        6 * 60,
  tutorial:   15 * 60,
  addPicture: 30 * 60,
  addDistance:30 * 60
};

let currentState: TimerState | null = null;

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
    `📋 Please read the instructions for ${label}. When you’re ready, type "Start ${label}" exactly below.`,
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
  statusBar.text = `$(clock) 00:00`;
  statusBar.show();

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
    const repo   = gitApi.repositories[0];
    const branch = repo.state.HEAD!.name!;

    await repo.add([]);
    await repo.commit(`Auto-commit: Time expired`, { all: true });
    await repo.push('origin', branch);
    installLockout();
    vscode.window.showInformationMessage('✅ All your code has been committed automatically!');
  } catch (err: any) {
    console.error('Error during auto-commit:', err);
    vscode.window.showErrorMessage(`Auto-commit failed: ${err.message}`);
  }
}

async function runTimerLoop(
  st: TimerState,
  statusBar: vscode.StatusBarItem,
  isWarmup: boolean,
  maxTasks: number
) {
  const pausePath = path.join(root, '.pause_timer');

  while (true) {
    // 1-second tick
    await new Promise(res => setTimeout(res, 1000));

    const nowSec      = Date.now() / 1000;
    const totalElapsed = Math.min(st.limit, st.elapsed + (nowSec - st.startTime));
    const remaining    = st.limit - totalElapsed;

    // Pause / commit detection
    if (fs.existsSync(pausePath)) {
      fs.unlinkSync(pausePath);

      // update elapsed & persist
      st.elapsed = totalElapsed;
      saveState(st);

      // immediate paused UI
      statusBar.text = `$(clock) ${formatTime(remaining)} (paused)`;
      statusBar.show();

      // confirmation pop-up
      await vscode.window.showInformationMessage(
        `✅ Task ${st.task} has been committed and pushed successfully!`,
        { modal: true }
      );

      // advance task
      st.task++;
      saveState(st);
      if (st.task > maxTasks) {
        await vscode.window.showInformationMessage(
          '🎉 All tasks complete! Your code has been pushed. Return to Canvas to submit.',
          { modal: true }
        );
        return;
      }

      // prompt next task
      const nextLabel = isWarmup ? 'warm-up task' : `Task ${st.task}`;
      const again     = await promptForStart(nextLabel);
      if (!again) return;

      // reset startTime (keep elapsed) & reinstall hook
      st.startTime = Date.now() / 1000;
      saveState(st);
      installPostCommitHook();

      // show resumed UI
      const resumedRem = st.limit - st.elapsed;
      statusBar.text   = `$(clock) ${formatTime(resumedRem)}`;
      statusBar.show();

      // loop afresh
      continue;
    }

    // normal tick: update UI & state
    statusBar.text = `$(clock) ${formatTime(remaining)}`;
    statusBar.show();
    saveState({ ...st, elapsed: totalElapsed });

    // 5-minute warning
    if (remaining <= 300 && remaining > 299) {
      await vscode.window.showWarningMessage(
        '⚠️ Only 5 minutes remaining!',
        { modal: true },
        'OK'
      );
    }

    // time’s up
    if (remaining <= 0) {
      await onTimerFinished(statusBar);
      return;
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

      // already complete?
      if (st.task > maxTasks) {
        await vscode.window.showInformationMessage(
          '🎉 You’ve completed all tasks! Your code is pushed—please return to Canvas to submit.',
          { modal: true }
        );
        return;
      }

      // resume after commit? or first prompt
      const pausePath = path.join(root, '.pause_timer');
      if (fs.existsSync(pausePath)) {
        fs.unlinkSync(pausePath);

        // confirmation & advance
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

        const nextLabel = isWarmup ? 'warm-up task' : `Task ${st.task}`;
        const again     = await promptForStart(nextLabel);
        if (!again) return;

        st.startTime = Date.now() / 1000;
        saveState(st);
      } else {
        const label = isWarmup ? 'warm-up task' : `Task ${st.task}`;
        const ready = await promptForStart(label);
        if (!ready) return;

        st.elapsed   = 0;
        st.startTime = Date.now() / 1000;
        saveState(st);
      }

      statusBar.text = `$(clock) ${formatTime(st.limit - st.elapsed)}`;
      statusBar.show();
      installPostCommitHook();

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
        `[${st.branch}] Running | Remaining: ${formatTime(remaining)}`
      );
    })
  );
}

export function deactivate() {
  // nothing needed here
}
