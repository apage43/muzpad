import { marked } from "marked";
import DOMPurify from "dompurify";

export function renderDocument(
  container: HTMLElement,
  source: string,
  path: string,
  files: Record<string, string>,
  open: (path: string, fragment: string) => void,
) {
  // Local projects can contain arbitrary Markdown and embedded HTML.
  container.innerHTML = DOMPurify.sanitize(
    marked.parse(source, { async: false }),
    {
      ALLOWED_TAGS: [
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "p",
        "br",
        "hr",
        "a",
        "strong",
        "em",
        "del",
        "s",
        "ul",
        "ol",
        "li",
        "blockquote",
        "pre",
        "code",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "details",
        "summary",
        "sup",
        "sub",
        "kbd",
        "input",
      ],
      ALLOWED_ATTR: [
        "href",
        "title",
        "start",
        "colspan",
        "rowspan",
        "align",
        "type",
        "checked",
        "disabled",
      ],
    },
  );
  container.scrollTop = 0;
  const ids = new Set<string>();
  container.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((heading) => {
    const base = (heading.textContent ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
      .replace(/\s/g, "-");
    let slug = base;
    for (let suffix = 1; ids.has(slug); suffix++) slug = `${base}-${suffix}`;
    ids.add(slug);
    heading.id = `doc-${slug}`;
  });
  container.querySelectorAll("input").forEach((input) => {
    input.type = "checkbox";
    input.disabled = true;
  });
  container.querySelectorAll("a").forEach((link) => {
    const href = link.getAttribute("href");
    if (!href) return;
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return;
    }
    try {
      const target = new URL(href, `https://workspace.invalid/${path}`);
      const resolved = decodeURIComponent(target.pathname.slice(1));
      const candidate = [
        resolved,
        `${resolved.replace(/\/$/, "")}/README.md`,
      ].find((name) => files[name] !== undefined);
      if (candidate) {
        link.onclick = (event) => {
          event.preventDefault();
          open(candidate, decodeURIComponent(target.hash.slice(1)));
        };
        return;
      }
    } catch {
      /* Malformed or unavailable local link. */
    }
    link.removeAttribute("href");
    link.title = "This file is not included in the workspace.";
  });
}

export function revealDocumentAnchor(container: HTMLElement, fragment: string) {
  const heading = Array.from(container.querySelectorAll("[id]")).find(
    (el) => el.id === `doc-${fragment}`,
  );
  if (heading)
    container.scrollTop +=
      heading.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      20;
}
