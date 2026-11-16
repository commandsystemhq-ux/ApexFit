import { useEffect, useImperativeHandle, useRef } from 'react';
import { useLocale } from '../contexts/LocaleContext.jsx';

const HEIGHT = 170;
const INK = '#0b1b3a';

function prepare(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(HEIGHT * ratio);
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, HEIGHT);
  context.lineWidth = 2.4;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = INK;
  return context;
}

// A touch/mouse/pen signature pad. The result is a PNG on a white background.
export default function SignaturePad({ ref, onChange, disabled = false }) {
  const { t } = useLocale();
  const canvasRef = useRef(null);
  const contextRef = useRef(null);
  const drawingRef = useRef(false);
  const inkRef = useRef(false);
  const lastRef = useRef(null);

  function setInk(value) {
    if (inkRef.current !== value) {
      inkRef.current = value;
      onChange?.(value);
    }
  }

  function clear() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    contextRef.current = prepare(canvas);
    setInk(false);
  }

  useImperativeHandle(ref, () => ({
    clear,
    hasInk: () => inkRef.current,
    toDataUrl: () => (inkRef.current ? canvasRef.current.toDataURL('image/png') : ''),
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    contextRef.current = prepare(canvas);

    // Keep the drawing when the layout width changes (rotation, window resize).
    let width = canvas.clientWidth;
    const observer = new ResizeObserver(() => {
      if (canvas.clientWidth === width || canvas.clientWidth === 0) return;
      const snapshot = inkRef.current ? canvas.toDataURL('image/png') : '';
      width = canvas.clientWidth;
      contextRef.current = prepare(canvas);
      if (snapshot) {
        const image = new Image();
        image.onload = () => contextRef.current.drawImage(image, 0, 0, canvas.clientWidth, HEIGHT);
        image.src = snapshot;
      }
    });
    observer.observe(canvas);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function point(event) {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function handleDown(event) {
    if (disabled) return;
    event.preventDefault();
    canvasRef.current.setPointerCapture?.(event.pointerId);
    drawingRef.current = true;
    const start = point(event);
    lastRef.current = start;
    // A tap leaves a dot.
    const context = contextRef.current;
    context.beginPath();
    context.arc(start.x, start.y, 1.2, 0, Math.PI * 2);
    context.fillStyle = INK;
    context.fill();
    setInk(true);
  }

  function handleMove(event) {
    if (!drawingRef.current) return;
    event.preventDefault();
    const next = point(event);
    const context = contextRef.current;
    context.beginPath();
    context.moveTo(lastRef.current.x, lastRef.current.y);
    context.lineTo(next.x, next.y);
    context.stroke();
    lastRef.current = next;
  }

  function handleUp() {
    drawingRef.current = false;
    lastRef.current = null;
  }

  return (
    <div className="sig-pad">
      <canvas
        ref={canvasRef}
        className="sig-canvas"
        style={{ height: HEIGHT }}
        role="img"
        aria-label={t('ctrCanvasLabel')}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
        onPointerLeave={handleUp}
      />
      <div className="sig-pad-footer">
        <small className="muted-copy">{t('ctrDrawHint')}</small>
        <button className="text-action" type="button" onClick={clear} disabled={disabled}>{t('ctrClear')}</button>
      </div>
    </div>
  );
}
