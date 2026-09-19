import {
  EditorState,
  Compartment,
  Prec,
  type Extension,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import {
  StreamLanguage,
  syntaxHighlighting,
  HighlightStyle,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";

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
  { tag: tags.comment, color: "var(--c-909090)", fontStyle: "italic" },
]);

export class SourceEditor {
  view: EditorView;
  extensions: Extension[];
  readonly = new Compartment();
  appearance = new Compartment();
  suppress = false;
  states = new Map<string, EditorState>();
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
          { dark: document.documentElement.dataset.theme === "dark" },
        ),
      ),
      basicSetup,
      muz,
      syntaxHighlighting(palette),
      this.readonly.of(EditorState.readOnly.of(false)),
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
        if (update.docChanged && !this.suppress)
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
          color: "var(--c-666)",
          fontFamily: "Arial, sans-serif",
          paddingRight: "8px",
        },
        ".cm-activeLine, .cm-activeLineGutter": {
          backgroundColor: "var(--c-151515)",
        },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
          backgroundColor: "var(--c-3a3a3a) !important",
        },
        ".cm-cursor": { borderLeftColor: "var(--c-eee)" },
        ".cm-panels, .cm-tooltip": {
          backgroundColor: "var(--c-191919)",
          color: "var(--c-eee)",
          fontFamily: "Arial, sans-serif",
        },
        ".cm-searchMatch": {
          backgroundColor: "var(--c-555)",
          outline: "1px solid var(--c-bbb)",
        },
      }),
    ];
    this.view = new EditorView({ parent, extensions: this.extensions });
  }
  open(path: string, text: string, readOnly: boolean) {
    this.suppress = true;
    if (this.path) this.states.set(this.path, this.view.state);
    const saved = this.states.get(path);
    if (saved && saved.doc.toString() === text) this.view.setState(saved);
    else
      this.view.setState(
        EditorState.create({ doc: text, extensions: this.extensions }),
      );
    this.path = path;
    this.view.dispatch({
      effects: this.readonly.reconfigure(EditorState.readOnly.of(readOnly)),
    });
    this.setTheme(document.documentElement.dataset.theme === "dark");
    this.suppress = false;
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
