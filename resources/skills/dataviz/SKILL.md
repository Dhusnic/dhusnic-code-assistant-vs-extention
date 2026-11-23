---
name: dataviz
description: Make charts, graphs, plots, stat tiles and dashboards that are readable, accessible and consistent in light and dark (matplotlib, plotly, d3, Recharts, inline SVG, plain HTML). Use whenever the user asks to chart, plot, graph, visualize or build a dashboard from data.
argument-hint: "[what to visualize, and the data file if any]"
---

# Data visualization

Make the chart answer one question, render it, and look at the result before you report it done.

## Rules for this project

- **No network.** Never load a library, font, icon or data from a CDN or any external URL, and never add telemetry. Use libraries already installed in the project or vendored in the repo (for a webview, a local file under `media/vendor/` loaded with a nonce script, no inline handlers). If a library is not installed, say so and fall back to inline SVG or plain HTML/CSS, which need nothing.
- Do not install packages unless the user agrees; installing is a network call.
- Embed small data inline in the output file. For a larger dataset, read it from a local file.
- Never put secrets or credentials in chart code, data files or labels.

## 1. Pick the form from the question

| Question | Use | Avoid |
|---|---|---|
| Compare values across categories | Horizontal bars, sorted by value | Pie, 3D, radar |
| Change over time | Line (many points) or columns (few periods) | Stacked areas with many series |
| Distribution | Histogram, box plot, or strip plot for small n | Averages alone |
| Part of a whole | Single stacked bar, or sorted bars of shares. Donut only for 2 to 4 parts | Pie with many slices |
| Relationship of two numbers | Scatter, with a trend line if useful | Dual y-axes |
| Many categories by many categories | Heatmap with a sequential scale | Rainbow scales |
| One headline number | Stat tile with a delta and a sparkline | A gauge |

Bars start at zero. Lines may use a tight range, but say so. If a table answers the question better, make a table. Prefer small multiples to a chart with more than 5 series.

## 2. Colour

Colour carries meaning, so use as little of it as you can.

- **One series: one colour.** Use a neutral for context and one accent for the thing to look at.
- **Categorical (at most 7):** use the palette below, in order. Beyond 7, group the tail as "Other" in grey or facet the chart.
- **Sequential** (low to high): one hue, light to dark (dark means more on a light background). **Diverging** (around a meaningful midpoint such as zero or a target): two hues meeting at a light neutral. Never use rainbow or jet.
- **Never colour alone.** Add direct labels, markers (circle, square, triangle), dash patterns, or position, so the chart works in greyscale and for colour-blind readers. Do not rely on red versus green; if you show good and bad, add an icon or a word.
- **Light and dark.** Define colours as variables and give each theme its own values; do not reuse the light palette on a dark background. Marks need at least 3:1 contrast against the background; text at least 4.5:1. Grid lines stay faint and never compete with the data.

Default palette. Ratios are against `#FFFFFF` (light) and `#121212` (dark), computed with the WCAG relative-luminance formula; every mark reaches at least 3:1.

| # | Light | Ratio | Dark | Ratio | Role |
|---|---|---|---|---|---|
| 1 | `#0072B2` | 5.2 | `#4C9BD6` | 6.2 | blue (default accent) |
| 2 | `#D55E00` | 3.9 | `#E8833A` | 6.9 | orange |
| 3 | `#009E73` | 3.4 | `#2FB58A` | 7.2 | green |
| 4 | `#CC79A7` | 3.1 | `#D98BB8` | 7.4 | pink |
| 5 | `#B8860B` | 3.3 | `#F2B134` | 9.9 | gold |
| 6 | `#7B5EA7` | 5.3 | `#A58BD6` | 6.5 | purple |
| 7 | `#5B6770` | 5.8 | `#9AA5AE` | 7.5 | grey ("Other", context) |

The light set follows the Okabe-Ito colour-blind-safe family, adjusted where needed for contrast. Text: `#1A1A1A` on white (17:1), `#E6E6E6` on `#121212`. If the project or user has brand colours, use them, but check their contrast with the same formula instead of judging by eye.

## 3. Labels, axes, legends, tooltips

- The title states the finding or the question ("Signups doubled after March"), not "Chart 1". Add a subtitle with unit, period and source.
- Label axes with units. Use thousands separators and a sensible number of ticks; format dates consistently. Do not rotate labels; switch to horizontal bars instead.
- Label lines and bars directly at their end instead of using a legend. If you need a legend, put it next to the data, in the same order as the marks.
- Remove chart junk: no 3D, heavy borders, gradients or shadows, and few grid lines.
- Tooltips (interactive output only) repeat the exact value and unit, and must not be the only way to read a value. Keyboard focus shows the same information.
- Sort bars by value unless the categories have a natural order (time, size, stage).
- Show missing data as gaps, not zeros. Note outliers instead of silently clipping them.

## 4. Stat tiles and KPI rows

- One tile: label (small, muted), value (large), delta with sign and a word or arrow ("+4.2% vs last week"), optional sparkline with no axes.
- Keep tiles the same size in a row and use one number format across them. A row holds 3 to 5 tiles.
- Say what the delta compares against. Colour the delta only if the direction has meaning, and pair the colour with an arrow or text.

## 5. Accessibility

- Give the chart an accessible name and a text alternative that states the main finding. For SVG: `role="img"` with `<title>` and `<desc>`. For canvas or images: `alt` text, plus a data table or a link to the data.
- Minimum text size 12 px in the rendered output.
- Respect `prefers-color-scheme` and `prefers-reduced-motion` (no animation when reduced).
- Interactive elements are reachable with the keyboard and show visible focus.

## 6. Tools

- **Python:** matplotlib is the safe default. Select the Agg backend (`matplotlib.use("Agg")`) so no window opens, and save with `savefig(dpi=150, bbox_inches="tight")` to a local PNG or SVG. Write Plotly HTML with its bundled JS (`include_plotlyjs=True`), never `"cdn"`, so the file is self-contained.
- **Web:** inline SVG or HTML/CSS needs no library. Use d3 or Recharts only if already in `package.json` or vendored. Drive colours through CSS variables so light and dark are one switch.
- Keep the data and the chart code in separate steps so the user can change the data later.

## 7. Verify by looking

1. Build the chart and write it to a file in the workspace.
2. Render it. For PNG or SVG, open the image with the file tools. For HTML, use the browser testing tools (screenshot) if enabled, or convert to PNG and view it. Check dark mode too if the output supports it.
3. Look for overlapping or clipped labels, wrong sort order, bars that do not start at zero, unreadable contrast, a legend in a different order from the marks, empty or NaN values, and text that overflows a tile.
4. Fix, render again, and only then report. If you cannot render, say so plainly instead of claiming it looks right.
5. Tell the user the file path, the question the chart answers, and any data you dropped, aggregated or assumed.
