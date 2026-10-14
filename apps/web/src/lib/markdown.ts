import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

// Open links in a new tab safely.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const MENTION = /(^|[^\w@.])@([a-zA-Z0-9][a-zA-Z0-9._-]{0,39})/g;

/** Wraps @handles in text nodes (outside code and links) with a styled span. */
function highlightMentions(root: DocumentFragment | HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!t.data.includes("@")) continue;
    if (t.parentElement?.closest("code, pre, a")) continue;
    targets.push(t);
  }
  for (const t of targets) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of t.data.matchAll(MENTION)) {
      const start = m.index! + m[1]!.length;
      frag.append(t.data.slice(last, start));
      const span = document.createElement("span");
      span.className = "mention";
      span.textContent = `@${m[2]}`;
      frag.append(span);
      last = start + 1 + m[2]!.length;
    }
    frag.append(t.data.slice(last));
    t.replaceWith(frag);
  }
}

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  const clean = DOMPurify.sanitize(html);
  const tpl = document.createElement("template");
  tpl.innerHTML = clean;
  highlightMentions(tpl.content);
  return tpl.innerHTML;
}
