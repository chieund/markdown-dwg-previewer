export type ViewBox = { x: number; y: number; w: number; h: number };

/** How much one wheel notch changes the view. */
const WHEEL_STEP = 1.1;
/** How much one button press changes the view — coarser, since it takes a click. */
export const BUTTON_STEP = 1.4;

export function getViewBox(svg: SVGSVGElement): ViewBox {
  const [x, y, w, h] = (svg.getAttribute('viewBox') ?? '0 0 100 100').split(' ').map(Number);
  return { x, y, w, h };
}

export function applyViewBox(svg: SVGSVGElement, vb: ViewBox): void {
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
}

/** Turns a client point into viewBox coordinates. */
export function clientToViewBox(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const vb = getViewBox(svg);
  const rect = svg.getBoundingClientRect();
  return {
    x: vb.x + ((clientX - rect.left) / rect.width) * vb.w,
    y: vb.y + ((clientY - rect.top) / rect.height) * vb.h,
  };
}

/** Scales the view about a fixed point, given in viewBox coordinates. */
export function zoomAbout(svg: SVGSVGElement, factor: number, px: number, py: number): void {
  const vb = getViewBox(svg);
  applyViewBox(svg, {
    x: px - (px - vb.x) * factor,
    y: py - (py - vb.y) * factor,
    w: vb.w * factor,
    h: vb.h * factor,
  });
}

/** Scales the view about the centre of what is currently on screen. */
export function zoomCentre(svg: SVGSVGElement, factor: number): void {
  const vb = getViewBox(svg);
  zoomAbout(svg, factor, vb.x + vb.w / 2, vb.y + vb.h / 2);
}

export function attachPanZoom(
  svg: SVGSVGElement,
  onReset: () => void,
  onChange?: () => void
): () => void {
  let isPanning = false;
  let lastX = 0;
  let lastY = 0;

  const changed = () => onChange?.();

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const point = clientToViewBox(svg, event.clientX, event.clientY);
    zoomAbout(svg, event.deltaY < 0 ? 1 / WHEEL_STEP : WHEEL_STEP, point.x, point.y);
    changed();
  };

  const onMouseDown = (event: MouseEvent) => {
    // Left button drags, middle button drags too — CAD users reach for the wheel.
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button === 1) event.preventDefault();
    isPanning = true;
    lastX = event.clientX;
    lastY = event.clientY;
    svg.style.cursor = 'grabbing';
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!isPanning) return;
    const vb = getViewBox(svg);
    const rect = svg.getBoundingClientRect();
    const dx = ((event.clientX - lastX) / rect.width) * vb.w;
    const dy = ((event.clientY - lastY) / rect.height) * vb.h;
    applyViewBox(svg, { ...vb, x: vb.x - dx, y: vb.y - dy });
    lastX = event.clientX;
    lastY = event.clientY;
    changed();
  };

  const onMouseUp = () => {
    if (!isPanning) return;
    isPanning = false;
    svg.style.cursor = 'grab';
  };

  const onDoubleClick = () => {
    onReset();
    changed();
  };

  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  svg.addEventListener('dblclick', onDoubleClick);
  // Middle-drag would otherwise open the browser's autoscroll widget.
  svg.addEventListener('auxclick', (event) => event.preventDefault());

  return () => {
    svg.removeEventListener('wheel', onWheel);
    svg.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    svg.removeEventListener('dblclick', onDoubleClick);
  };
}
