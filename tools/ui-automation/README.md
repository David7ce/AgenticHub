# ui-automation — drive VS Code's Agents window without a mouse recipe

PowerShell 5.1 scripts for **Windows only** that read and operate a desktop window through
Windows UI Automation (the accessibility tree), the way the AHP acceptance test of
`docs/harness.md` was run on 2026-11-11. Nothing here is a dependency of the hub; it is a
test aid. All of it acts on the person's real desktop: run it only when they asked for that.

| Script | What it does |
|---|---|
| `uia-list.ps1` | Top-level windows with their process (read-only). |
| `uia-dump.ps1 -Title Agents -Max 200` | Named buttons, edits, list items of one window (read-only). |
| `uia-invoke.ps1 -Name <exact> \| -Like <wildcard>` | Invoke / select / expand one element by name. |
| `uia-send.ps1 -Text <msg>` | Focus the chat box of the Agents window, type, press Send. |
| `uia-path.ps1 -Path <dir>` / `uia-enter.ps1` | Fill the in-window "Select Folder" box; Enter confirms (twice: first navigates). |
| `uia-cmd.ps1 -Title <window> -Cmd ">Chat: Open Agents Window"` | Command palette via Ctrl+Shift+P keystrokes. |
| `uia-rclick.ps1 -Like <name> [-Left]` | Real mouse click on an element (right click opens its menu, then use `uia-invoke`). |
| `uia-esc.ps1` / `uia-close.ps1` | Escape, close the Agents window. |
| `shot.ps1 <file.png>` | Screenshot of the Agents window. |

Things learned the hard way:

- Chromium builds the accessibility tree on the first query: the first dump returns ~13
  elements, the second ~1500. `uia-dump.ps1` already retries.
- The Agents window can sit on another monitor, so coordinates may be negative.
- The chat box is Monaco without screen-reader mode: typing needs keystrokes (`uia-send.ps1`),
  not `ValuePattern`. A dropdown that stays open swallows the text: send Escape first.
- Archiving a session ("Done") does **not** free its agent process; deleting it
  (right click, Delete…, Delete) does, and closing the window frees only the draft session.
- Window titles are hardcoded (`Agents`, `AgenticHub - Visual Studio Code`): adjust to yours.
