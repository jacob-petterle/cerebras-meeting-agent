import type { RenderCommand } from '@meeting-agent/protocol';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { IconMonitor } from '../lib/icons';
import { assertNever } from '../lib/assert-never';
import { useHarnessStore } from '../store';
import { Sandbox } from './sandbox';

/**
 * The Display target. A pure `kind -> component` switch on RenderCommand.kind,
 * modeled on Shipyard's deliverable-viewers.tsx. html/markdown/mermaid render into
 * the sandboxed iframe; json/log into <pre>; image into <img>. mermaid is NOT a
 * deliverable kind -- it's rendered to SVG client-side (mermaid.js) then handed to
 * the sandbox. marked + mermaid are dynamically imported so they never weigh down
 * the initial load.
 */

function StageLoading({ label }: { label: string }) {
  return (
    <div className="empty">
      <div className="spinner" />
      <span className="t">{label}</span>
    </div>
  );
}

function StageError({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="stage-error" role="alert">
      <strong>{message}</strong>
      {detail ? <div className="d">{detail}</div> : null}
    </div>
  );
}

function prettyJson(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return payload;
  }
}

/** Markdown -> HTML via `marked` (dynamic import), then into the sandbox. */
function MarkdownView({ payload, pluginData }: { payload: string; pluginData: Record<string, unknown> }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    void (async () => {
      try {
        const { marked } = await import('marked');
        const out = await marked.parse(payload, { async: true, breaks: true });
        if (!cancelled) setHtml(out);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [payload]);

  if (error) return <StageError message="Markdown render failed" detail={error} />;
  if (html === null) return <StageLoading label="Rendering markdown…" />;
  return <Sandbox content={html} pluginData={pluginData} />;
}

/** Mermaid source -> SVG via `mermaid` (dynamic import), then into the sandbox. */
function MermaidView({ payload, pluginData }: { payload: string; pluginData: Record<string, unknown> }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
        const id = `m${Math.random().toString(36).slice(2)}`;
        const result = await mermaid.render(id, payload);
        if (!cancelled) setSvg(result.svg);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [payload]);

  if (error) return <StageError message="Mermaid render failed" detail={error} />;
  if (svg === null) return <StageLoading label="Rendering diagram…" />;
  return <Sandbox content={svg} pluginData={pluginData} />;
}

function StageContent({ cmd }: { cmd: RenderCommand }): ReactNode {
  const pluginData = useMemo<Record<string, unknown>>(
    () => ({ kind: cmd.kind, title: cmd.title ?? null, deliverableId: cmd.deliverableId ?? null }),
    [cmd.kind, cmd.title, cmd.deliverableId],
  );

  switch (cmd.kind) {
    case 'html':
      return <Sandbox content={cmd.payload} pluginData={pluginData} />;
    case 'markdown':
      return <MarkdownView payload={cmd.payload} pluginData={pluginData} />;
    case 'mermaid':
      return <MermaidView payload={cmd.payload} pluginData={pluginData} />;
    case 'json':
      return <pre className="stage-pre">{prettyJson(cmd.payload)}</pre>;
    case 'log':
      return <pre className="stage-pre">{cmd.payload}</pre>;
    case 'image':
      return (
        <div className="stage-img-wrap">
          {/* payload is a URL or file path supplied by the server; rendered as-is. */}
          <img className="stage-img" src={cmd.payload} alt={cmd.title ?? 'Shared image'} />
        </div>
      );
    default:
      return assertNever(cmd.kind);
  }
}

function StageEmpty() {
  return (
    <div className="empty">
      <IconMonitor size={26} className="glyph" />
      <span className="t">Nothing shared yet</span>
      <span className="h">share_screen renders here</span>
    </div>
  );
}

export function Stage() {
  const render = useHarnessStore((state) => state.render);
  const renderCount = useHarnessStore((state) => state.renderCount);

  return (
    <section className="stage-pane" aria-label="Stage">
      <div className="stage-head">
        <IconMonitor size={15} aria-hidden="true" style={{ color: 'var(--faint)' }} />
        <span className="eyebrow">Stage</span>
        <span className="title">{render?.title ?? (render ? 'Shared artifact' : 'Idle')}</span>
        {render ? <span className="kindtag">{render.kind}</span> : null}
      </div>
      <div className="stage-body">
        {render ? <StageContent key={renderCount} cmd={render} /> : <StageEmpty />}
      </div>
    </section>
  );
}
