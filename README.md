# WT Localization Editor

An Electron-based tool to edit War Thunder `/lang/*.csv` files safely.

## Features

- Pick your `War Thunder/lang` directory (or the game root and it will detect `/lang`).
- List all CSVs in `/lang`.
- Select a language **column** (e.g., `English`, `Russian`, etc.).
- Find entries by **exact** key or **exact** current value in the selected language.
- If multiple rows have the same value, you get a **disambiguation table**.
- **Pink circular edit button** on each row to make a precise edit.
- Only the **selected language column** is modified—keys and other languages remain untouched.
- **Undo** the last change.
- All edits are written to a persistent log: `<userData>/res/changes.json`.

> Tip: The first column in each CSV is assumed to be the localization **key**.

## Install & Run

```bash
# In this folder
npm install
npm start
```

Optionally package installers:

```bash
npm run package
```

## How it works

- The app parses CSVs using `csv-parse` and writes them with `csv-stringify`.
- It auto-detects delimiter (`,` vs `;`) per file.
- Config and change logs are stored under Electron's `app.getPath('userData')`.
- IPC is used to keep the renderer sandboxed (no Node integration).

## Notes

- Exact match means the query must equal either the key (first column) **or** the current text in the chosen language column, character-for-character.
- If you search and then immediately edit, the matches table refreshes to reflect your change.
- `Undo` re-applies the previous value on the last edited key in that file and language.
