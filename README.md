# tex-preview

A Claude Code mod that shows the compiled PDF of the LaTeX document Claude is editing, in a pane beside the chat.

Whenever Claude edits or writes a `.tex` file, the mod compiles the document and draws the page the edit landed on (found with SyncTeX). Compile errors show at the top of the pane with their file and line, and the last good page stays on screen.

- **Finds the main file of a chapter**: a `% !TEX root = main.tex` comment, or else a `.tex` with `\documentclass` in the same folder or the one above that `\input`s or `\include`s the chapter.
- **Fast first**: one pass of the engine shows the edit right away; when the log asks for another run (references, citations, bibliography), `latexmk` settles it in the background.
- **Engine**: `pdflatex` by default; `xelatex` or `lualatex` with `% !TEX program = ...`, and `xelatex` when the document loads `fontspec`.
- **Getting around**: ◀ ▶ a page at a time (**p** and **n** while the pane has the keyboard), ◀◀ ▶▶ ten pages, ⏮ ⏭ the first and last, a **Página** field to type a page number, and and two pickers with the page each heading starts on: **Capítulo**, and **Seção** for the sections of the chapter shown (a document without chapters gets **Seção** and **Subseção**). The pages are found with SyncTeX after each compile, in the files the compile's log shows the document read; on a long thesis each heading takes about 140 ms, so the pickers fill a level at a time, chapters first. SyncTeX places a chapter on the page where LaTeX broke the page for it, before pending figures, so a chapter's page is then confirmed with `pdftotext`: the first page from there whose top holds its title. The two pages either side of the one shown are rendered ahead.
- **Pane buttons**: **Recompilar**, and **Abrir PDF** to open it in your PDF viewer.
- **Command**: `/tex path/to/file.tex` compiles a file and opens the pane at any time; `/tex` alone recompiles the current one.
- **Edit in the pane**: **Editar esta página** opens the `.tex` where the page shown begins, at the start of its first paragraph (found with SyncTeX's inverse search, about a second on a long thesis), even in a chapter's own file; **Ver a seção inteira** shows the rest of that section. A picker lists the document's other `.tex` files (its folder and the folders just below). Enter saves and recompiles, back on the page of the first line you changed; Shift+Enter breaks the line. A file over 60,000 characters opens a section at a time: a picker lists its sections and subsections (any `\...section`, `\...chapter` or `\...part` command at the start of a line, a class's own such as `\spesection` included), it opens the one holding Claude's last edit, and a save puts the section back in its place in the whole file. If the file changes on disk while you edit, by Claude or another editor, nothing is written over: the pane says so and lets you reload.

The page is drawn as an image, in color when it fits the pane's size limit and in grayscale otherwise. It only reacts to Claude's edits: after editing in your own editor, press **Recompilar** or run `/tex`.

The pane shows one page at a time: in testing, the desktop app stopped drawing it, or the mod stopped answering, once several page images were drawn together. To read the whole document, **Abrir PDF** opens it in your PDF viewer; a viewer that reloads the file when it changes, such as SumatraPDF, follows every compile.

## Requirements

A TeX distribution with `latexmk`, `pdftocairo`, `pdftotext` and `synctex` on the `PATH` (a full TeX Live install has all four; on macOS, MacTeX). Without `pdftotext`, chapters keep SyncTeX's page. The pane needs the Claude desktop app or the VS Code extension; the terminal shows the PDF's path instead.

**No LaTeX on the machine?** The pane says so and offers **Instalar LaTeX (TinyTeX)**: one press downloads [TinyTeX](https://yihui.org/tinytex/), a small TeX Live (about 200 MB, a few minutes), with its official installer into your user folder, no administrator needed, then adds `latexmk` and `synctex` (and, on Windows, `pdftocairo` and `pdftotext`). On macOS and Linux those two come from poppler instead: `brew install poppler`, or `sudo apt install poppler-utils`. When a compile then stops on a class or package the machine lacks (``File `abntex2.cls' not found``), the pane offers to install the package holding it with `tlmgr`. Nothing is downloaded without a press. The Windows flow is covered by tests; the macOS and Linux installs have not been tried.

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
