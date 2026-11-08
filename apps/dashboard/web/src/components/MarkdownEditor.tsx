import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
  Bold,
  Code,
  Heading2,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  SquareCode,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Segmented, cx } from "./ui";

type View = "write" | "split" | "preview";

// --- editing commands --------------------------------------------------------

/** Wraps each selection in `before`/`after`, or removes the wrapping if it's already there. */
function wrap(view: EditorView, before: string, after = before, placeholder = "text"): boolean {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      const outer = state.sliceDoc(range.from - before.length, range.to + after.length);
      if (outer === before + text + after && text) {
        return {
          changes: [
            { from: range.from - before.length, to: range.from },
            { from: range.to, to: range.to + after.length },
          ],
          range: EditorSelection.range(range.from - before.length, range.to - before.length),
        };
      }
      const inner = text || placeholder;
      return {
        changes: { from: range.from, to: range.to, insert: before + inner + after },
        range: EditorSelection.range(range.from + before.length, range.from + before.length + inner.length),
      };
    }),
  );
  view.focus();
  return true;
}

/** Toggles a prefix on every line touched by the selection (numbered lists count up). */
function prefixLines(view: EditorView, prefix: string | ((i: number) => string), match: RegExp): boolean {
  const { state } = view;
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) lines.add(n);
  }
  const nums = [...lines].sort((a, b) => a - b);
  const all = nums.every((n) => match.test(state.doc.line(n).text));
  const changes = nums.map((n, i) => {
    const line = state.doc.line(n);
    const existing = match.exec(line.text)?.[0] ?? "";
    if (all) return { from: line.from, to: line.from + existing.length };
    const p = typeof prefix === "function" ? prefix(i) : prefix;
    // Replace another list/heading/quote marker rather than stacking them.
    const other = /^(#{1,6} |> |[-*+] \[[ x]\] |[-*+] |\d+[.)] )/.exec(line.text)?.[0] ?? "";
    return { from: line.from, to: line.from + other.length, insert: p };
  });
  view.dispatch({ changes });
  view.focus();
  return true;
}

function codeBlock(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;
  const text = state.sliceDoc(r.from, r.to);
  const startOfLine = r.from === state.doc.lineAt(r.from).from;
  const lead = startOfLine ? "" : "\n";
  const insert = `${lead}\`\`\`\n${text || ""}\n\`\`\`\n`;
  const cursor = r.from + lead.length + 3 + 1;
  view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: EditorSelection.range(cursor, cursor + text.length) });
  view.focus();
  return true;
}

function link(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;
  const text = state.sliceDoc(r.from, r.to) || "link text";
  const insert = `[${text}](https://)`;
  const urlFrom = r.from + text.length + 3;
  view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: EditorSelection.range(urlFrom, urlFrom + 8) });
  view.focus();
  return true;
}

const TOOLS: { icon: LucideIcon; label: string; run: (v: EditorView) => boolean }[][] = [
  [
    { icon: Heading2, label: "Heading", run: (v) => prefixLines(v, "## ", /^#{1,6} /) },
    { icon: Bold, label: "Bold (Ctrl+B)", run: (v) => wrap(v, "**") },
    { icon: Italic, label: "Italic (Ctrl+I)", run: (v) => wrap(v, "_") },
  ],
  [
    { icon: List, label: "Bulleted list", run: (v) => prefixLines(v, "- ", /^[-*+] (?!\[[ x]\] )/) },
    { icon: ListOrdered, label: "Numbered list", run: (v) => prefixLines(v, (i) => `${i + 1}. `, /^\d+[.)] /) },
    { icon: ListChecks, label: "Checklist", run: (v) => prefixLines(v, "- [ ] ", /^[-*+] \[[ x]\] /) },
    { icon: Quote, label: "Quote", run: (v) => prefixLines(v, "> ", /^> /) },
  ],
  [
    { icon: Code, label: "Inline code", run: (v) => wrap(v, "`", "`", "code") },
    { icon: SquareCode, label: "Code block", run: codeBlock },
    { icon: Link, label: "Link", run: link },
  ],
];

// --- look --------------------------------------------------------------------

const theme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--ink)", fontSize: "13px", height: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65", overflow: "auto" },
  ".cm-content": { padding: "12px 0", caretColor: "var(--ink)" },
  ".cm-line": { padding: "0 14px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-wash) !important" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--surface-2) 60%, transparent)" },
  ".cm-placeholder": { color: "var(--ink-3)" },
  ".cm-gutters": { display: "none" },
});

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", fontSize: "1.15em", color: "var(--ink)" },
  { tag: t.heading2, fontWeight: "700", fontSize: "1.08em", color: "var(--ink)" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "700", color: "var(--ink)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--ink-3)" },
  { tag: t.monospace, color: "var(--s2)" },
  { tag: t.quote, color: "var(--ink-2)", fontStyle: "italic" },
  { tag: t.list, color: "var(--ink)" },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword], color: "var(--s7)" },
  { tag: [t.string, t.special(t.string)], color: "var(--s3)" },
  { tag: [t.number, t.bool, t.atom], color: "var(--s4)" },
  { tag: t.comment, color: "var(--ink-3)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.typeName, t.className], color: "var(--s1)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--s5)" },
]);

// --- component ---------------------------------------------------------------

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  maxLength,
  height = 420,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  height?: number;
  label: string;
}) {
  const [view, setView] = useState<View>("split");
  const ref = useRef<ReactCodeMirrorRef>(null);
  const extensions = useMemo<Extension[]>(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": label }),
      keymap.of([
        { key: "Mod-b", run: (v) => wrap(v, "**") },
        { key: "Mod-i", run: (v) => wrap(v, "_") },
        { key: "Mod-e", run: (v) => wrap(v, "`", "`", "code") },
        { key: "Mod-k", run: link },
      ]),
      ...(placeholder ? [placeholderExt(placeholder)] : []),
      theme,
    ],
    [placeholder, label],
  );
  const run = (fn: (v: EditorView) => boolean) => {
    const v = ref.current?.view;
    if (!v) return;
    if (view === "preview") setView("split");
    fn(v);
  };
  const over = maxLength !== undefined && value.length > maxLength;
  const showEditor = view !== "preview";
  const showPreview = view !== "write";

  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20 transition">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2/60 px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-0.5" role="toolbar" aria-label="Formatting">
          {TOOLS.map((group, gi) => (
            <div key={gi} className={cx("flex items-center gap-0.5", gi > 0 && "border-l border-line pl-1 ml-1")}>
              {group.map(({ icon: Icon, label: l, run: fn }) => (
                <button
                  key={l}
                  type="button"
                  title={l}
                  aria-label={l}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => run(fn)}
                  className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-surface-3 hover:text-ink transition"
                >
                  <Icon className="size-4" />
                </button>
              ))}
            </div>
          ))}
        </div>
        <Segmented<View>
          value={view}
          onChange={setView}
          options={[
            { value: "write", label: "Write" },
            { value: "split", label: "Split" },
            { value: "preview", label: "Preview" },
          ]}
        />
      </div>
      <div className={cx("grid", view === "split" && "md:grid-cols-2")}>
        <div className={cx(!showEditor && "hidden", view === "split" && "border-b md:border-b-0 md:border-r border-line")} style={{ height }}>
          <CodeMirror
            ref={ref}
            value={value}
            onChange={onChange}
            extensions={extensions}
            theme="none"
            height="100%"
            style={{ height: "100%" }}
            basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLineGutter: false, autocompletion: false, searchKeymap: true }}
          />
        </div>
        {showPreview && (
          <div className="overflow-auto px-5 py-3" style={{ height }} aria-label="Preview">
            {value.trim() ? (
              <div className="md-preview">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-[13px] text-ink-3 pt-1">Nothing to preview yet.</p>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-1.5 text-[11px] text-ink-3">
        <span>
          Markdown with GitHub extensions. <kbd className="font-mono">Ctrl/⌘ B</kbd> bold · <kbd className="font-mono">I</kbd> italic ·{" "}
          <kbd className="font-mono">E</kbd> code · <kbd className="font-mono">K</kbd> link
        </span>
        <span className={cx("tabular", over && "text-critical-ink font-medium")}>
          {value.length.toLocaleString()}
          {maxLength !== undefined && ` / ${maxLength.toLocaleString()}`} characters
        </span>
      </div>
    </div>
  );
}
