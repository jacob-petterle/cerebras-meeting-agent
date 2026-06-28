import { useEffect, useMemo, useRef } from 'react';
import { isRecord } from '../lib/is-record';

/**
 * Sandboxed-iframe primitive for the stage, modeled on Shipyard's html-sandbox.tsx
 * but trimmed for a static local render. Agent-authored HTML/SVG runs in an opaque
 * origin (no allow-same-origin) so it can't reach the parent app; an injected
 * theme keeps it visually consistent with the console. Same idea as Shipyard:
 * isolation comes from the iframe origin + sandbox attribute, the CSP just keeps a
 * viz from breaking the host page.
 */

const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals';

const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src * \'unsafe-inline\' \'unsafe-eval\' data: blob:; img-src * data: blob:; style-src * \'unsafe-inline\' data:; font-src * data:; object-src \'none\'; base-uri \'self\'">';

/** Dark theme injected into every frame -- mirrors the app's tokens. */
const THEME_CSS = `
:root{--bg:#090b11;--surface:#0f131c;--surface2:#161b27;--text:#e7eaf2;--muted:#98a1b5;--border:#232b3d;--accent:#2fd4bd;--font-sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--font-mono:ui-monospace,"SF Mono",Menlo,Monaco,Consolas,monospace}
html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font-family:var(--font-sans)}
body{padding:18px;line-height:1.55}
a{color:var(--accent)}
h1,h2,h3,h4{line-height:1.25}
pre{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;overflow:auto;font-family:var(--font-mono)}
code{font-family:var(--font-mono);background:var(--surface2);padding:.1em .35em;border-radius:4px}
pre code{background:transparent;padding:0}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid var(--border);padding:6px 10px;text-align:left}
blockquote{margin:0;padding:.2em 1em;border-left:3px solid var(--border);color:var(--muted)}
hr{border:0;border-top:1px solid var(--border)}
img,svg{max-width:100%;height:auto}
svg{display:block;margin:0 auto}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
*{scrollbar-width:thin;scrollbar-color:var(--border) transparent}
`;

/**
 * Option B (cheap future Shipyard-plugin compat): the parent posts plugin-data into
 * the frame on load; the frame may call window.shipyardPush(payload) to send a
 * 'shipyard-plugin-push' message back. postMessage layer only -- no server change.
 * Also rewrites link clicks to open in a new tab instead of navigating the frame.
 */
const BRIDGE_SCRIPT = `<script>
(function(){
  window.addEventListener('message',function(e){
    if(e&&e.data&&e.data.type==='shipyard-plugin-data'){
      window.__shipyardPluginData=e.data.payload;
      window.dispatchEvent(new CustomEvent('shipyard-plugin-data',{detail:e.data.payload}));
    }
  });
  window.shipyardPush=function(p){parent.postMessage({type:'shipyard-plugin-push',payload:p},'*');};
  document.addEventListener('click',function(e){
    var a=e.target;while(a&&a.tagName!=='A')a=a.parentElement;
    if(a&&a.href&&/^https?:/.test(a.href)){e.preventDefault();window.open(a.href,'_blank','noopener');}
  });
})();
</script>`;

function hasHtmlStructure(content: string): boolean {
  const lead = content.trimStart().slice(0, 20).toLowerCase();
  return lead.startsWith('<!doctype') || lead.startsWith('<html');
}

function buildSrcDoc(content: string): string {
  const head = `<meta charset="utf-8">${CSP_META}<style>${THEME_CSS}</style>${BRIDGE_SCRIPT}`;
  if (hasHtmlStructure(content)) {
    const lower = content.toLowerCase();
    const headClose = lower.indexOf('</head>');
    if (headClose !== -1) {
      return content.slice(0, headClose) + head + content.slice(headClose);
    }
    const htmlOpen = lower.indexOf('<html');
    if (htmlOpen !== -1) {
      const tagEnd = content.indexOf('>', htmlOpen);
      if (tagEnd !== -1) {
        return `${content.slice(0, tagEnd + 1)}<head>${head}</head>${content.slice(tagEnd + 1)}`;
      }
    }
    return `<!doctype html><html><head>${head}</head><body>${content}</body></html>`;
  }
  return `<!doctype html><html><head>${head}</head><body>${content}</body></html>`;
}

interface SandboxProps {
  content: string;
  /** Posted into the frame as `shipyard-plugin-data` on load (Option B). */
  pluginData?: Record<string, unknown>;
  /** Fires when the frame calls `shipyardPush()` (Option B). */
  onPluginPush?: (payload: unknown) => void;
}

export function Sandbox({ content, pluginData, onPluginPush }: SandboxProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const srcDoc = useMemo(() => buildSrcDoc(content), [content]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onLoad = () => {
      frame.contentWindow?.postMessage(
        { type: 'shipyard-plugin-data', payload: pluginData ?? {} },
        '*',
      );
    };
    frame.addEventListener('load', onLoad);
    return () => frame.removeEventListener('load', onLoad);
  }, [pluginData, srcDoc]);

  useEffect(() => {
    if (!onPluginPush) return;
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data: unknown = event.data;
      if (isRecord(data) && data.type === 'shipyard-plugin-push') {
        onPluginPush(data.payload);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onPluginPush]);

  return (
    <iframe ref={frameRef} className="stage-frame" sandbox={SANDBOX} srcDoc={srcDoc} title="Stage render" />
  );
}
