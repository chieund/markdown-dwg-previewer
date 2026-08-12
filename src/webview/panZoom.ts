export type ViewBox = { x: number; y: number; w: number; h: number };

export function getViewBox(svg: SVGSVGElement): ViewBox {
  const [x, y, w, h] = (svg.getAttribute('viewBox') ?? '0 0 100 100').split(' ').map(Number);
  return { x, y, w, h };
}

export function applyViewBox(svg: SVGSVGElement, vb: ViewBox): void {
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
}

export function attachPanZoom(svg: SVGSVGElement, onReset: () => void): () => void {
  let isPanning = false;
  let lastX = 0;
  let lastY = 0;

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const vb = getViewBox(svg);
    const scaleFactor = event.deltaY < 0 ? 0.9 : 1.1;
    const rect = svg.getBoundingClientRect();
    const px = vb.x + ((event.clientX - rect.left) / rect.width) * vb.w;
    const py = vb.y + ((event.clientY - rect.top) / rect.height) * vb.h;

    applyViewBox(svg, {
      x: px - (px - vb.x) * scaleFactor,
      y: py - (py - vb.y) * scaleFactor,
      w: vb.w * scaleFactor,
      h: vb.h * scaleFactor,
    });
  };

  const onMouseDown = (event: MouseEvent) => {
    isPanning = true;
    lastX = event.clientX;
    lastY = event.clientY;
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
  };

  const onMouseUp = () => {
    isPanning = false;
  };

  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  svg.addEventListener('dblclick', onReset);

  return () => {
    svg.removeEventListener('wheel', onWheel);
    svg.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    svg.removeEventListener('dblclick', onReset);
  };
}
