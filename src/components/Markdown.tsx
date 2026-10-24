import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { ReactNode } from 'react';

// Math: $$…$$ or \[…\] (display), $…$ or \(…\) (inline). Bold: **…**.
// Bold first when it starts earlier, so "**… $x$ …**" keeps its math (rendered inside the bold).
const TOKEN = /\*\*([^*]+)\*\*|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g;

function Tex({ tex, display }: { tex: string; display: boolean }) {
  const html = katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, strict: false });
  return <span className={display ? 'math-display' : undefined} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Text with inline math and bold. */
function Inline({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [, bold, dd, br, d, pr] = m;
    if (bold != null) out.push(<b key={m.index}><Inline text={bold} /></b>); // bold text may hold math too
    else out.push(<Tex key={m.index} tex={dd ?? br ?? d ?? pr} display={dd != null || br != null} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** Small Markdown renderer for AI summaries: ## headings, - bullets, paragraphs, LaTeX math. */
export default function Markdown({ text }: { text: string }) {
  // Keep a multi-line $$…$$ / \[…\] block on one logical line so it renders as one equation.
  const joined = text.replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]/g, (m) => m.replace(/\n/g, ' '));
  const out: ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length) out.push(<ul key={out.length}>{items.map((t, i) => <li key={i}><Inline text={t} /></li>)}</ul>);
    items = [];
  };
  for (const raw of joined.split('\n')) {
    const line = raw.trim();
    if (/^[-*•]\s+/.test(line)) items.push(line.replace(/^[-*•]\s+/, ''));
    else {
      flush();
      if (/^#{1,6}\s/.test(line)) out.push(<h3 key={out.length}><Inline text={line.replace(/^#+\s*/, '')} /></h3>);
      else if (line) out.push(<p key={out.length}><Inline text={line} /></p>);
    }
  }
  flush();
  return <>{out}</>;
}
