# SEAL Programming Study Extension

A VS Code extension for GitHub Codespaces that enforces branch-specific time budgets and automates Git commits/pushes when time runs out.

## Key Features

- **Branch-based limits**   
  - `tutorial` branch: 15 minutes  
  - `addPicture` & `addDistance` branches: 30 minutes  
- **Live countdown** in the status bar (`$(clock) MM:SS`)  
- **5-minute warning** modal when only 5 minutes remain  
- **Auto-commit & push** when the timer hits zero  
- **Pause after push**: timer stops, and a “Start” button lets you immediately begin the next countdown  
- **Lockout hook**: once auto-committed & pushed, installs a `pre-commit` hook that prevents further commits on that branch

## Installation

1. Clone or download the `.vsix` from the Marketplace or build locally.  
2. In VS Code: **Extensions** → **Install from VSIX...** → select `codespace-timer-<version>.vsix`.  
3. Open a GitHub Codespace (or any Git repo) and ensure you have an upstream remote named `origin`.

## Available Commands

- **Start Timer** (`extension.startTimer`)  
  Reads your current branch, resets or resumes its timer, installs the post-commit hook, and begins the countdown.  
- **Pause Timer** (`extension.pauseTimer`)  
  Manually pauses the countdown and updates the status bar.  
- **Show Status** (`extension.showStatus`)  
  Displays a modal with the branch name, whether the timer is running or paused, and the remaining time.

You can invoke any command via the Command Palette (`⌘⇧P` or `Ctrl+Shift+P`).

## How It Works

1. **Starting**  
   - Click **Start Code Timer**.  
   - A modal prompts: “Please read the task instructions… Click ‘Start’ when ready.”  
   - On “Start”, the extension reads/initializes `<workspace>/.timer_state.json`, installs a `post-commit` hook, and shows the live countdown in the status bar.  
2. **Five-Minute Warning**  
   - When remaining time drops to 5:00 exactly, a warning modal pops: “⚠️ Only 5 minutes remaining!”  
3. **Auto-Commit & Push**  
   - At 00:00, the extension stages all changes, commits with message `Auto-commit: time expired`, pushes to `origin/<branch>`, installs a restrictive `pre-commit` hook (to block further commits), and shows a confirmation.  
4. **Pause After Push**  
   - The post-commit hook writes a small `.pause_timer` file and runs `git push origin`.  
   - Your interval loop sees that file, clears the timer, deletes it, and shows a modal with a single **Start** button.  
   - Clicking **Start** re-invokes `extension.startTimer`, resetting/resuming for the next task on the same branch.

## Configuration & Customization

- **Branch limits** are defined in code under `BRANCH_LIMITS`. To change them, modify the numbers (in seconds) and rebuild.  
- **Hooks** live under `.git/hooks/`.  
- If you add new feature branches, add an entry in `BRANCH_LIMITS` or rely on the default 30 minutes.

## Troubleshooting

- **Timer not showing?** Make sure you ran **Start Timer** and you’re in a Git repo.  
- **Commits not blocked after expiration?** Verify that `.git/hooks/pre-commit` is executable and contains the lockout script.  
- **Hooks not firing?** VS Code’s Git sometimes uses `--no-verify`; rely on the extension’s built-in detection instead.

---

Happy coding (and timing)!  
