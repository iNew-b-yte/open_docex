import { useLayoutEffect, useRef } from 'react';
import { useShell } from './useSession.js';

/**
 * The element the editor builds its DOM in. React never renders children into it
 * (LLD Part 3 §3, §14).
 */
export function EditorHost() {
  const { session } = useShell();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    session.attachEditor(ref.current);
    return () => session.attachEditor(null);
  }, [session]);
  return <div ref={ref} className="odx-editor-host" />;
}
