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
    return execSync('git branch --show-current', { cwd: root })
      .toString()
      .trim();
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
  const target = `Start ${label}`;

  // Show a modal message first to get the user's attention
  await vscode.window.showInformationMessage(
    `📋 Please read the instructions for ${label}. When you're ready, you'll need to type "${target}" exactly.`,
    { modal: true },
    'Continue'
  );

  function createPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      'startTask',
      `Start ${label}`,
      // Use a dedicated view column to make it more prominent
      vscode.ViewColumn.One,
      { 
        enableScripts: true, 
        retainContextWhenHidden: true
      }
    );
    
    panel.webview.html = `
      <style>
        body, html { 
          margin: 0; 
          padding: 0; 
          height: 100%; 
          background-color: rgba(0,0,0,0.85); /* Darker background */
          color: white;
          font-family: system-ui, -apple-system, sans-serif;
        }
        .backdrop {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0,0,0,0.7);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .dialog {
          background: #2d2d2d; /* Darker dialog */
          padding: 2rem; 
          border-radius: 8px; 
          width: 400px;
          box-shadow: 0 0 20px rgba(0,0,0,0.5);
          border: 1px solid #555;
        }
        h2 {
          margin-top: 0;
          color: #ffffff;
        }
        code {
          display: block;
          background: #444;
          padding: 0.75rem;
          margin: 1rem 0;
          border-radius: 4px;
          font-size: 1.1rem;
          text-align: center;
          color: #00ff00;
        }
        input { 
          width: 100%; 
          padding: 0.75rem; 
          margin: 1rem 0; 
          background: #333;
          color: white;
          border: 1px solid #666;
          border-radius: 4px;
          font-size: 1rem;
          box-sizing: border-box;
        }
        button { 
          width: 100%; 
          padding: 0.75rem; 
          background: #0078d4; 
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 1rem;
          cursor: pointer;
        }
        button:disabled {
          background: #444;
          cursor: not-allowed;
        }
      </style>
      <div class="backdrop">
        <div class="dialog">
          <h2>Start Task</h2>
          <p>📋 Read the instructions for ${label}.<br/>
             When you're ready, type exactly:</p>
          <code>${target}</code>
          <input id="txt" placeholder="${target}" autofocus />
          <button id="btn" disabled>Start</button>
        </div>
      </div>
      <script>
        const vscode = acquireVsCodeApi();
        const input = document.getElementById('txt');
        const btn = document.getElementById('btn');
        
        // Focus the input field immediately
        setTimeout(() => input.focus(), 100);
        
        input.addEventListener('input', () => {
          btn.disabled = input.value !== '${target}';
        });
        
        btn.addEventListener('click', () => {
          vscode.postMessage({ command: 'start', value: input.value });
        });
        
        // Add enter key support
        input.addEventListener('keyup', (e) => {
          if (e.key === 'Enter' && input.value === '${target}') {
            vscode.postMessage({ command: 'start', value: input.value });
          }
        });
      </script>
    `;
    return panel;
  }

  return new Promise<boolean>(resolve => {
    let panel = createPanel();
    let wasSuccessful = false; // Flag to track if the user typed the correct command

    const attachHandlers = (p: vscode.WebviewPanel) => {
      p.webview.onDidReceiveMessage(msg => {
        if (msg.command === 'start' && msg.value === target) {
          wasSuccessful = true;
          resolve(true);
          p.dispose();
        }
      });
      p.onDidDispose(() => {
        if (!wasSuccessful) {
          vscode.window.showErrorMessage(`You must type "${target}" to proceed.`)
          .then(() => {
            panel = createPanel();
            attachHandlers(panel);
          });
        }
      });
    };

    attachHandlers(panel);
  });
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
    await new Promise(res => setTimeout(res, 1000));

    const nowSec       = Date.now() / 1000;
    const totalElapsed = Math.min(st.limit, st.elapsed + (nowSec - st.startTime));
    const remaining    = st.limit - totalElapsed;

    if (fs.existsSync(pausePath)) {
      fs.unlinkSync(pausePath);

      st.elapsed = totalElapsed;
      saveState(st);

      statusBar.text = `$(clock) ${formatTime(remaining)} (paused)`;
      statusBar.show();

      await vscode.window.showInformationMessage(
        `✅ Task ${st.task} has been committed and pushed successfully!`,
        { modal: true }
      );

      st.task++;
      saveState(st);
      if (st.task > maxTasks) {
        await vscode.window.showInformationMessage(
          '🎉 Congratulations! You have completed all tasks for this feature. You code has been pushed. Please stop recording your video, return to Canvas to provide a link to your video recording, and then move on to the next item in the lab.',
          { modal: true }
        );
        return;
      }

      const nextLabel = isWarmup ? 'warm-up task' : `Task ${st.task}`;
      const again     = await promptForStart(nextLabel);
      if (!again) return;

      st.startTime = Date.now() / 1000;
      saveState(st);
      installPostCommitHook();

      statusBar.text = `$(clock) ${formatTime(st.limit - st.elapsed)}`;
      statusBar.show();
      continue;
    }

    statusBar.text = `$(clock) ${formatTime(remaining)}`;
    statusBar.show();
    saveState({ ...st, elapsed: totalElapsed });

    if (remaining <= 300 && remaining > 299) {
      await vscode.window.showWarningMessage(
        '⚠️ Only 5 minutes remaining!',
        { modal: true },
        'OK'
      );
    }

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

      if (st.task > maxTasks) {
        await vscode.window.showInformationMessage(
          '🎉 Congratulations! You have completed all tasks for this feature. You code has been pushed. Please stop recording your video, return to Canvas to provide a link to your video recording, and then move on to the next item in the lab.',
          { modal: true }
        );
        return;
      }

      const pausePath = path.join(root, '.pause_timer');
      if (fs.existsSync(pausePath)) {
        fs.unlinkSync(pausePath);

        await vscode.window.showInformationMessage(
          `✅ Task ${st.task} has been committed and pushed successfully!`,
          { modal: true }
        );
        st.task++;
        if (st.task > maxTasks) {
          await vscode.window.showInformationMessage(
            '🎉 Congratulations! You have completed all tasks for this feature. You code has been pushed. Please stop recording your video, return to Canvas to provide a link to your video recording, and then move on to the next item in the lab.',
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