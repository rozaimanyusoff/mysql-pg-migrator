import { useEffect, useRef, useState, type ReactNode } from 'react';

interface ResizableJobPanelProps {
  storageKey: string;
  defaultWidth: number;
  children: ReactNode;
  className?: string;
  minWidth?: number;
  maxWidth?: number;
}

export default function ResizableJobPanel({
  storageKey,
  defaultWidth,
  children,
  className = '',
  minWidth = 220,
  maxWidth = 640,
}: ResizableJobPanelProps) {
  const [width, setWidth] = useState(defaultWidth);
  const widthRef = useRef(defaultWidth);

  useEffect(() => {
    const saved = Number(window.localStorage.getItem(storageKey));
    if (Number.isFinite(saved)) {
      const next = Math.min(maxWidth, Math.max(minWidth, saved));
      widthRef.current = next;
      setWidth(next);
    }
  }, [maxWidth, minWidth, storageKey]);

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widthRef.current;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.min(maxWidth, Math.max(minWidth, startWidth + startX - moveEvent.clientX));
      widthRef.current = next;
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.localStorage.setItem(storageKey, String(widthRef.current));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className={`relative shrink-0 ${className}`} style={{ width }}>
      <div
        role="separator"
        aria-label="Resize jobs panel"
        aria-orientation="vertical"
        title="Drag to resize"
        onPointerDown={startResize}
        className="group absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize touch-none"
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-violet-400 group-active:bg-violet-500" />
      </div>
      {children}
    </div>
  );
}
