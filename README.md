# tex-preview

A Claude Code mod that shows the compiled PDF of the LaTeX document Claude is editing, in a pane beside the chat.

Whenever Claude edits or writes a `.tex` file, the mod compiles the document and draws the page the edit landed on (found with SyncTeX). Compile errors show at the top of the pane with their file and line, and the last good page stays on screen.

- **Finds the main file of a chapter**: a `% !TEX root = main.tex` comment, or else a `.tex` with `\documentclass` in the same folder or the one above that `\input`s or `\include`s the chapter.
- **Fast first**: one pass of the engine shows the edit right away; when the log asks for another run (references, citations, bibliography), `latexmk` settles it in the background.
- **Engine**: `pdflatex` by default; `xelatex` or `lualatex` with `% !TEX program = ...`, and `xelatex` when the document loads `fontspec`.
- **Pane buttons**: ◀ ▶ to change page (neighbouring pages are rendered ahead), **Recompilar**, and **Abrir PDF** to open it in your PDF viewer.
- **Command**: `/tex path/to/file.tex` compiles a file and opens the pane at any time; `/tex` alone recompiles the current one.
- **Edit in the pane**: **Editar .tex** opens the file Claude last edited, with a picker for the document's other `.tex` files (its folder and the folders just below). Enter saves and recompiles, back on the page of the first line you changed; Shift+Enter breaks the line. A file over 60,000 characters opens a section at a time: a picker lists its sections and subsections (any `\...section`, `\...chapter` or `\...part` command at the start of a line, a class's own such as `\spesection` included), it opens the one holding Claude's last edit, and a save puts the section back in its place in the whole file. If the file changes on disk while you edit, by Claude or another editor, nothing is written over: the pane says so and lets you reload.

The page is drawn as an image, in color when it fits the pane's size limit and in grayscale otherwise. It only reacts to Claude's edits: after editing in your own editor, press **Recompilar** or run `/tex`.

The pane shows one page at a time: in testing, the desktop app stopped drawing it, or the mod stopped answering, once several page images were drawn together. To read the whole document, **Abrir PDF** opens it in your PDF viewer; a viewer that reloads the file when it changes, such as SumatraPDF, follows every compile.

## Requirements

A TeX distribution with `latexmk`, `pdftocairo` and `synctex` on the `PATH` (a full TeX Live install has all three; on macOS, MacTeX). The pane needs the Claude desktop app or the VS Code extension; the terminal shows the PDF's path instead.

## Install

At the prompt of a terminal session:

```
/plugin install tex-preview --marketplace lunatila/tex-preview
```

From a shell:

```bash
claude plugin install tex-preview --marketplace lunatila/tex-preview
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `lunatila/tex-preview`, then Add plugin.
