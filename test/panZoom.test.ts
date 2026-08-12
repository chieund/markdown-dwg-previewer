import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUTTON_STEP,
  applyViewBox,
  clientToViewBox,
  getViewBox,
  zoomAbout,
  zoomCentre,
} from '../src/webview/panZoom';

const near = (actual: number, expected: number, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} to be within ${tol} of ${expected}`);

/** The zoom helpers only touch viewBox and the element's box, so a stub is enough. */
function fakeSvg(viewBox: string, rect = { left: 0, top: 0, width: 800, height: 600 }) {
  let current = viewBox;
  return {
    getAttribute: (name: string) => (name === 'viewBox' ? current : null),
    setAttribute: (name: string, value: string) => {
      if (name === 'viewBox') current = value;
    },
    getBoundingClientRect: () => rect,
  } as unknown as SVGSVGElement;
}

test('a viewBox round-trips through read and write', () => {
  const svg = fakeSvg('10 20 30 40');
  assert.deepEqual(getViewBox(svg), { x: 10, y: 20, w: 30, h: 40 });

  applyViewBox(svg, { x: -5, y: -6, w: 7, h: 8 });
  assert.deepEqual(getViewBox(svg), { x: -5, y: -6, w: 7, h: 8 });
});

test('a factor below 1 zooms in, above 1 zooms out', () => {
  const svg = fakeSvg('0 0 100 100');

  zoomCentre(svg, 0.5);
  near(getViewBox(svg).w, 50, 1e-12);

  zoomCentre(svg, 4);
  near(getViewBox(svg).w, 200, 1e-12);
});

test('the toolbar buttons move the view in the direction their labels promise', () => {
  const svg = fakeSvg('0 0 100 100');

  // "+" divides by the step, "−" multiplies — mixing these up is the easy bug
  zoomCentre(svg, 1 / BUTTON_STEP);
  assert.ok(getViewBox(svg).w < 100, 'zoom in must show a smaller slice of the drawing');

  zoomCentre(svg, BUTTON_STEP);
  near(getViewBox(svg).w, 100, 1e-9);
});

test('zooming about a point leaves that point where it was', () => {
  const svg = fakeSvg('0 0 100 100');
  const anchor = { x: 25, y: 75 };

  for (const factor of [0.5, 2, 0.9, 1.1]) {
    const before = getViewBox(svg);
    const relX = (anchor.x - before.x) / before.w;
    const relY = (anchor.y - before.y) / before.h;

    zoomAbout(svg, factor, anchor.x, anchor.y);

    const after = getViewBox(svg);
    near((anchor.x - after.x) / after.w, relX, 1e-12);
    near((anchor.y - after.y) / after.h, relY, 1e-12);
  }
});

test('zooming about the centre keeps the centre fixed', () => {
  const svg = fakeSvg('40 40 20 20');
  const centreBefore = { x: 50, y: 50 };

  zoomCentre(svg, 3);

  const after = getViewBox(svg);
  near(after.x + after.w / 2, centreBefore.x, 1e-12);
  near(after.y + after.h / 2, centreBefore.y, 1e-12);
  near(after.w, 60, 1e-12);
});

test('a client point maps into the drawing through the viewBox', () => {
  const svg = fakeSvg('0 0 800 600', { left: 0, top: 0, width: 800, height: 600 });

  assert.deepEqual(clientToViewBox(svg, 0, 0), { x: 0, y: 0 });
  assert.deepEqual(clientToViewBox(svg, 400, 300), { x: 400, y: 300 });
  assert.deepEqual(clientToViewBox(svg, 800, 600), { x: 800, y: 600 });
});

test('the element offset and zoom level are both accounted for', () => {
  // The canvas starts 100px right and 50px down, and shows a 2× magnified view
  const svg = fakeSvg('1000 2000 400 300', { left: 100, top: 50, width: 800, height: 600 });

  const centre = clientToViewBox(svg, 100 + 400, 50 + 300);
  near(centre.x, 1200);
  near(centre.y, 2150);
});
