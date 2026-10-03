import {
  EditorState,
  EditorSelection,
  Compartment,
  Prec,
  countColumn,
  type StateEffect,
  type Extension,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import {
  StreamLanguage,
  syntaxHighlighting,
  HighlightStyle,
  foldService,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { isDarkTheme } from "./theme";

const muz = StreamLanguage.define({
  startState: () => ({ comment: false }),
  token(stream, state) {
    if (state.comment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.comment = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.comment = true;
      return "comment";
    }
    if (stream.match(/"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/\b(?:let|fn|use|as|if|else|true|false)\b/))
      return "keyword";
    if (stream.match(/\b\d+(?:\.\d+)?(?:b|bar|ms|s|hz|db)?\b/i))
      return "number";
    if (stream.match(/[a-zA-Z_]\w*/)) return "variableName";
    stream.next();
    return null;
  },
});
const palette = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--c-ffffff)", fontWeight: "bold" },
  { tag: tags.string, color: "var(--c-dadada)" },
  { tag: tags.number, color: "var(--c-ffffff)" },
  { tag: tags.comment, color: "var(--text-muted)", fontStyle: "italic" },
]);

export class SourceEditor {
  view: EditorView;
  extensions: Extension[];
  readonly = new Compartment();
  appearance = new Compartment();
  accessibility = new Compartment();
  suppress = false;
  states = new Map<
    string,
    { state: EditorState; scroll: StateEffect<unknown> }
  >();
  path = "";
  constructor(
    parent: HTMLElement,
    onChange: (text: string) => void,
    run: () => void,
  ) {
    this.extensions = [
      this.appearance.of(
        EditorView.theme(
          {},
          { dark: isDarkTheme(document.documentElement.dataset.theme) },
        ),
      ),
      basicSetup,
      muz,
      foldService.of((state, lineStart, lineEnd) => {
        const line = state.doc.lineAt(lineStart);
        const whitespace = line.text.search(/\S/);
        if (whitespace < 0) return null;
        const indent = countColumn(line.text, state.tabSize, whitespace);
        let end = lineEnd;
        for (let number = line.number + 1; number <= state.doc.lines; number++) {
          const next = state.doc.line(number), prefix = next.text.search(/\S/);
          if (prefix < 0) continue;
          if (countColumn(next.text, state.tabSize, prefix) <= indent) break;
          end = next.to;
        }
        return end > lineEnd ? { from: lineEnd, to: end } : null;
      }),
      syntaxHighlighting(palette),
      this.readonly.of(EditorState.readOnly.of(false)),
      this.accessibility.of(EditorView.contentAttributes.of({ "aria-label": "Source editor · no file open" })),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              run();
              return true;
            },
          },
        ]),
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && this.path && !this.suppress && !update.state.readOnly)
          onChange(update.state.doc.toString());
      }),
      EditorView.theme({
        "&": {
          height: "100%",
          color: "var(--c-eaeaea)",
          backgroundColor: "var(--c-080808)",
        },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily:
            '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
          fontSize: "13px",
          lineHeight: "1.65",
        },
        ".cm-content": { padding: "20px 0", caretColor: "var(--c-eee)" },
        ".cm-line": { paddingLeft: "12px" },
        ".cm-gutters": {
          backgroundColor: "var(--c-080808)",
          border: "none",
          color: "var(--text-muted)",
          fontFamily: "Arial, sans-serif",
          paddingRight: "8px",
        },
        ".cm-activeLine, .cm-activeLineGutter": {
          backgroundColor: "var(--c-151515)",
        },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
          backgroundColor: "var(--selection-background) !important",
        },
        "&.cm-focused .cm-selectionBackground": {
          outline: "1px solid var(--focus-ring)",
        },
        ".cm-content ::selection": {
          backgroundColor: "var(--selection-background)",
          color: "var(--selection-text)",
        },
        ".cm-cursor": { borderLeftColor: "var(--c-eee)" },
        ".cm-panels, .cm-tooltip": {
          backgroundColor: "var(--c-191919)",
          color: "var(--c-eee)",
          fontFamily: "Arial, sans-serif",
        },
        ".cm-searchMatch": {
          backgroundColor: "var(--selection-background)",
          outline: "1px solid var(--focus-ring)",
        },
      }),
    ];
    this.view = new EditorView({ parent, extensions: this.extensions });
  }
  checkpoint() {
    if (!this.path) return;
    this.states.set(this.path, {
      state: this.view.state,
      scroll: this.view.scrollSnapshot(),
    });
  }
  detach() {
    this.checkpoint();
    this.path = "";
    this.view.dispatch({
      effects: this.readonly.reconfigure([
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ]),
    });
  }
  clear() {
    this.detach();
    this.states.clear();
    this.view.setState(
      EditorState.create({ extensions: this.extensions }),
    );
    this.detach();
    this.setTheme(isDarkTheme(document.documentElement.dataset.theme));
  }
  remeasure() {
    this.view.requestMeasure();
  }
  open(path: string, text: string, readOnly: boolean) {
    if (!path) {
      this.detach();
      return;
    }
    this.checkpoint();
    this.suppress = true;
    this.path = "";
    try {
      const saved = this.states.get(path);
      const compatible = saved?.state.doc.toString() === text;
      if (saved && !compatible) this.states.delete(path);
      const selection = saved && !compatible
        ? EditorSelection.create(
            saved.state.selection.ranges.map((range) =>
              EditorSelection.range(
                Math.min(range.anchor, text.length),
                Math.min(range.head, text.length),
              ),
            ),
            saved.state.selection.mainIndex,
          )
        : undefined;
      this.view.setState(
        compatible && saved
          ? saved.state
          : EditorState.create({ doc: text, selection, extensions: this.extensions }),
      );
      this.view.dispatch({
        effects: [
          this.accessibility.reconfigure(EditorView.contentAttributes.of({
            "aria-label": `${readOnly ? "Read-only source" : "Source editor"} · ${path.slice(path.indexOf(":") + 1)}`,
            "aria-readonly": String(readOnly),
          })),
          this.readonly.reconfigure([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          this.appearance.reconfigure(
            EditorView.theme({}, {
              dark: isDarkTheme(document.documentElement.dataset.theme),
            }),
          ),
          compatible && saved
            ? saved.scroll
            : EditorView.scrollIntoView(this.view.state.selection.main.head),
        ],
      });
      this.path = path;
    } finally {
      this.suppress = false;
    }
  }
  setTheme(dark: boolean) {
    this.view.dispatch({
      effects: this.appearance.reconfigure(EditorView.theme({}, { dark })),
    });
  }
  jump(line: number, column = 1) {
    const target = this.view.state.doc.line(
      Math.min(Math.max(1, line), this.view.state.doc.lines),
    );
    const offset =
      target.from +
      Array.from(target.text)
        .slice(0, column - 1)
        .join("").length;
    this.view.dispatch({
      selection: { anchor: Math.min(offset, target.to) },
      effects: EditorView.scrollIntoView(offset, { y: "center" }),
    });
    this.view.focus();
  }
}
