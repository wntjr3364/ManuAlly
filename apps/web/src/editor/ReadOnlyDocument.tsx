// Plain rendering of stored document JSON (text only, never HTML). Used for documents the editor
// cannot open and for showing a recovery copy that can no longer be merged.
import type { ReactNode } from 'react';
import type { JSONContent } from '@tiptap/core';

export function renderDocument(json: JSONContent): ReactNode[] {
  const render = (n: JSONContent, key: number): ReactNode => {
    const kids = (n.content ?? []).map(render);
    const marked = (text: ReactNode) => (n.marks ?? []).reduce<ReactNode>((acc, m) => {
      switch (m.type) {
        case 'bold': return <strong>{acc}</strong>;
        case 'italic': return <em>{acc}</em>;
        case 'subscript': return <sub>{acc}</sub>;
        case 'superscript': return <sup>{acc}</sup>;
        default: return acc;
      }
    }, text);
    switch (n.type) {
      case 'text': return <span key={key}>{marked(n.text)}</span>;
      case 'heading': return <h3 key={key}>{kids}</h3>;
      case 'paragraph': return <p key={key}>{kids}</p>;
      case 'table': return <table key={key}><tbody>{kids}</tbody></table>;
      case 'table_row': return <tr key={key}>{kids}</tr>;
      case 'table_cell': return <td key={key}>{kids}</td>;
      case 'citation': return <span key={key} className="atom">[인용{n.attrs?.locator ? `, ${String(n.attrs.locator)}` : ''}]</span>;
      case 'math_inline': return <span key={key} className="atom">⟨{String(n.attrs?.latex ?? '')}⟩</span>;
      case 'figure_ref': return <span key={key} className="atom">[그림/표]</span>;
      default: return <span key={key}>{kids}</span>;
    }
  };
  return (json.content ?? []).map(render);
}

export function ReadOnlyDocument({ content, reason }: { content: JSONContent; reason: string }) {
  return (
    <section className="card">
      <p role="alert" className="error">이 원고에는 {reason}가 있어 읽기 전용으로 엽니다. 저장된 내용은 그대로 보존되며 이 화면에서는 저장할 수 없습니다.</p>
      <div className="editor readonly" data-testid="editor">{renderDocument(content)}</div>
    </section>
  );
}
