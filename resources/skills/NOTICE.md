# Built-in skills: origin and changes

These skills ship with Infraon Code Assistant and load with the lowest precedence: a personal, team or project skill
with the same name replaces the built-in one. They are read-only; copy one to change it.

| Skill | Origin | License |
|---|---|---|
| `docx`, `pdf`, `pptx`, `xlsx`, `skill-creator` | Anthropic's document and skill-authoring skills | Apache License 2.0 (`LICENSE.txt` in each folder) |
| `import-memory`, `code-review`, `simplify`, `security-review`, `init`, `run`, `pr-creation`, `dataviz`, `update-config` | Written for Infraon Code Assistant | Same license as the extension |

## Changes made for Infraon (Apache 2.0, section 4(b))

All skills:
- Each `SKILL.md` declares `requires:` (checked by Infraon's skill doctor) and its instructions refer to Infraon's tools
  (`view_image`, sub-agents via `agent`) instead of claude.ai artifacts, connectors or Cowork.
- Shell snippets were replaced by one-line commands that work in PowerShell, cmd and bash.
- Python text files are read and written as UTF-8 (Windows defaults to a legacy code page).

`docx`, `pptx`, `xlsx`:
- `scripts/office/soffice.py`: finds LibreOffice outside PATH (Windows, macOS, `SOFFICE_PATH`); the Linux socket shim is
  only used on Linux. `accept_changes.py` and `recalc.py` use the same lookup.
- New `scripts/office/unpack.py`, `pack.py` and `render.py` (safe extract, repack, page images).

`pdf`:
- `convert_pdf_to_images.py` falls back to pypdfium2 when Poppler is missing; new `crop_image.py` replaces ImageMagick.

`skill-creator`:
- Removed `run_eval.py`, `run_loop.py`, `improve_description.py`, `generate_report.py` and `utils.py`: they ran the
  `claude` CLI, which would send skill content to an outside service. Description tuning is done with sub-agents instead.
- The review viewer is generated as a static HTML file; `quick_validate.py` accepts Infraon's frontmatter keys and
  CRLF files.
