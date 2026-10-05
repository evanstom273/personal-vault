---
name: Personal Vault
description: A quiet Markdown notebook with a compact explorer and spacious writing pane.
colors:
  paper: "#faf9f6"
  panel: "#eeeee7"
  ink: "#24392f"
  muted: "#58665d"
  line: "#d3d7cd"
  green: "#285941"
  green-hover: "#1c4430"
  select: "#dce8dc"
  selected-ink: "#173d29"
  red: "#9d322b"
  white: "#ffffff"
typography:
  display:
    fontFamily: "Georgia, serif"
    fontSize: "48px"
    lineHeight: 1.1
  title:
    fontFamily: "Georgia, serif"
    fontSize: "32px"
    lineHeight: 1.3
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "15px"
    lineHeight: 1.5
  reading:
    fontFamily: "Georgia, serif"
    fontSize: "18px"
    lineHeight: 1.8
  editor:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "15px"
    lineHeight: 1.8
  label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "12px"
rounded:
  note: "5px"
  control: "6px"
  dialog: "12px"
spacing:
  control-gap: "8px"
  section: "14px"
  medium: "16px"
  writing-mobile: "20px"
  panel: "24px"
  writing: "28px"
components:
  button-primary:
    backgroundColor: "{colors.green}"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-primary-hover:
    backgroundColor: "{colors.green-hover}"
  button-secondary:
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  search-input:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "10px"
  note-selected:
    backgroundColor: "{colors.select}"
    textColor: "{colors.selected-ink}"
    rounded: "{rounded.note}"
    padding: "10px 12px"
---

# Design System: Personal Vault

## Overview

**Creative North Star: "Notebook interface"**

Preserve the existing warm off-white and forest-green palette. The interface is quiet, compact around navigation and spacious around writing. System sans keeps controls readable, serif gives reading and note titles a notebook character, and monospace belongs to Markdown editing and code.

**Key Characteristics:**

- Warm paper surfaces with restrained forest-green actions.
- Compact explorer and spacious writing pane.
- Clear saving, conflict, empty and error states.

The implementation source is `src/notebook.ts`; browser behavior lives in `web/app.ts`. Tokens above describe the incumbent implementation.

## Colors

### Primary

Forest green (`green`) marks primary actions, links, focus and the editing caret. The deeper `green-hover` identifies a hovered primary action. The pale `select` surface distinguishes the selected note and secondary hover states; `selected-ink` supports the active note name.

### Neutral

Warm `paper` is the writing and search surface; `panel` separates the explorer and code blocks. `ink` carries controls and text, `muted` carries metadata and hints, and `line` draws quiet dividers. Primary actions use white text. Reserved `red` marks deletion. Notices use warm amber rather than the action color.

## Typography

System sans is the control and general body face. Georgia supplies titles, the brand and Markdown reading. The editor uses the system monospace stack and a generous line height for source text. Labels and metadata remain compact. Note-list titles use a medium weight (550).

The login title uses the display role; the note-name field uses the title role. The brand is (25px) and the empty-state heading is (38px). Reading content is constrained to (74ch). At the mobile breakpoint, note titles reduce to (27px) and Markdown source to (14px).

## Layout

The desktop app fills the viewport height with a left explorer and a flexible writing pane. The explorer is (290px), growing to (320px) from a viewport width of (1400px). Its search stays above a separately scrolling list. The workspace header is (72px) high. The editor uses (28px) vertical padding and horizontal padding of `clamp(20px, 5vw, 76px)`.

At widths up to (700px), the app uses one column. A **Notes** button reveals the explorer as a fixed full-width panel beneath the (64px) header. The editor has (20px) padding. Keep the toolbar compact and the writing area full-width. Preview replaces the Markdown source rather than creating a competing split pane. Backlinks sit below the writing area, followed by download, delete and word count.

## Elevation & Depth

The interface is flat: paper and panel tones, single-pixel borders and spacing separate regions. There are no box shadows. The help dialog uses a dark translucent backdrop (`#18281d88`) to distinguish the modal layer.

## Shapes

Controls have gently rounded corners using `control`; note rows use `note`, and the help dialog uses `dialog`. The title field stays square with only a bottom border. Buttons have a minimum height of (40px), with smaller backlink buttons at (32px). Avoid turning the writing area into a card grid.

## Components

### Buttons

Primary buttons use forest green with white text; secondary buttons are transparent with a quiet border. Hovering secondary controls uses the selected-note wash. Disabled buttons lower opacity to (0.5). Deletion keeps a textual red signal and explicit confirmation. Focus uses a (2px) forest-green outline offset by (4px), shared with links and fields.

### Inputs / Fields

Search uses a paper background, a single-pixel border and a visible label. The title field is serif with a bottom rule. Markdown source is a transparent, borderless textarea; its distinct monospace face separates editing from reading. Keep labels independent of placeholder text.

### Navigation

Each note row contains a wrapping name and a muted, single-line excerpt. Selected rows use `aria-current` and the pale green surface. Mobile navigation preserves this same explorer, revealed by the **Notes** control with an expanded state.

### Reading and state feedback

Markdown preview uses serif body text, muted blockquotes with a thin green rule, and panel-toned code blocks. Long code and tables scroll horizontally. Saving feedback remains in the header; actionable errors and conflicts appear in the notice region. The help dialog keeps connection details and keyboard shortcuts near the notebook.

## Do's and Don'ts

### Do:

- **Do** preserve warm paper surfaces and forest-green actions.
- **Do** keep search above the note list and backlinks below the writing pane.
- **Do** use system sans for controls, serif for reading and monospace for Markdown source.
- **Do** keep visible focus, explicit save status and understandable conflict feedback.

### Don't:

- **Don't** add a decorative hero or dashboard metrics inside the notebook.
- **Don't** hide the editor behind unnecessary cards or split panes.
- **Don't** use color alone to communicate destructive actions or errors.
