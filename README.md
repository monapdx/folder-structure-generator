# Folder Structure Generator (Visual)

A **browser-based** folder / file tree builder with a clean, shareable visual output.

Build a folder structure, reorganize it with true drag & drop, and export a polished diagram for README files, pitches, docs, or planning.

## Features

- **Add folders & files** at any level
- **True drag & drop** reordering (including moving items into other folders)
- **Context menu (right-click)**: add / rename / delete
- **Search** to jump to a folder or file
- **Templates** to start fast (React app, Python package, Writing project)
- **Export** the diagram as **PNG** or **SVG**
- **Export / import JSON** to save your structure and reload it later
- Fully client-side (your data stays on your machine)

## Quick start

```bash
npm install
npm run dev
```

Then open the local URL Vite prints (usually `http://localhost:5173`).

## Build

```bash
npm run build
npm run preview
```

## Export tips

- PNG is great for sharing in docs/screenshots.
- SVG is ideal for crisp scaling in READMEs and slide decks.

## Tech stack

- React + Vite
- `@dnd-kit` for drag & drop
- `html-to-image` for PNG/SVG export

## Roadmap ideas

- Optional **tree layout modes** (compact, spacious, “README” preset)
- **Keyboard shortcuts** (rename, delete, new folder/file)
- More templates (Node CLI, Electron app, Streamlit suite, etc.)

## Contributing

PRs are welcome. See **CONTRIBUTING.md**.

## License

MIT — see **LICENSE**.
