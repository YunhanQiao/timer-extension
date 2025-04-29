# Codespace Timer

A VS Code extension for GitHub Codespaces that:

- Shows a live countdown timer in the status bar  
- Alerts you at 5 minutes remaining  
- Auto-commits and pushes when the timer hits zero  
- Pauses after each auto-commit

## Features

1. **Start Countdown Timer**  
   Launch via the Command Palette (`Start Countdown Timer`) and enter minutes.  
2. **Live Status-Bar Display**  
   Shows `$(clock) MM:SS` ticking down.  
3. **5-Minute Warning**  
   Pops a ⚠️ warning toast at `05:00`.  
4. **Auto Git Commit & Push**  
   Stages, commits, and pushes your changes when time’s up.

## Usage

1. Install the extension (from VSIX or Marketplace).  
2. Run **Start Countdown Timer** from the Command Palette.  
3. Watch the timer, make edits, and—when time’s up—your changes will auto-commit.

## Requirements

- A Git repository with an upstream remote in your Codespace.  
- VS Code’s built-in Git extension (it’s enabled by default).

## Extension Settings

_None for now._

## Known Issues

- New (untracked) files are _all_ staged by default—adjust your `.gitignore` as needed.