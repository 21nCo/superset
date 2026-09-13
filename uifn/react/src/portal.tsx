import { resolveUIFnPortalTarget } from '@uifn/dom';
import React from 'react';
import ReactDOM from 'react-dom';

export interface PortalProps {
  children?: React.ReactNode;
  container?: HTMLElement | null;
}

export const Portal: React.FC<PortalProps> = ({ children, container }) => {
  const [portalReady, setPortalReady] = React.useState(false);
  const ownerDocument = container?.ownerDocument
    ?? (typeof document === 'undefined' ? null : document);
  const mountNode = React.useMemo(
    () => ownerDocument
      ? resolveUIFnPortalTarget(ownerDocument, container ?? undefined)
      : null,
    [container, ownerDocument],
  );

  const [fallbackHost, setFallbackHost] = React.useState<HTMLElement | null>(null);
  const needsFallbackHost = !!ownerDocument && mountNode === ownerDocument.documentElement && !ownerDocument.body;
  React.useEffect(() => {
    setPortalReady(true);
    if (!needsFallbackHost || !ownerDocument || !mountNode) return;
    // React 19 redirects an HTML-element portal to document.body. A real
    // element host keeps body-less documents usable without creating a body.
    const host = ownerDocument.createElement('div');
    host.setAttribute('data-uifn-portal-host', '');
    mountNode.appendChild(host);
    setFallbackHost(host);
    return () => { host.remove(); setFallbackHost(null); };
  }, [needsFallbackHost, ownerDocument, mountNode]);

  // Portals have no server-rendered owner. Keeping descendants absent until
  // the portal is ready means they mount once under their final portal owner,
  // instead of first mounting in a fragment and then remounting after hydration.
  if (!mountNode || !portalReady || (needsFallbackHost && fallbackHost?.parentNode !== mountNode)) return null;

  try {
    return ReactDOM.createPortal(children, needsFallbackHost ? fallbackHost! : mountNode);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Portals are not currently supported')) {
      return null;
    }
    throw error;
  }
};
