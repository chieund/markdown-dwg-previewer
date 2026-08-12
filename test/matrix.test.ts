import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENTITY,
  applyToPoint,
  determinant,
  isSimilarity,
  multiply,
  rotate,
  rotationAngle,
  scale,
  similarityScale,
  translate,
} from '../src/dxf/matrix';

const near = (actual: number, expected: number, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} to be within ${tol} of ${expected}`);

const nearPoint = (actual: { x: number; y: number }, x: number, y: number, tol = 1e-9) => {
  near(actual.x, x, tol);
  near(actual.y, y, tol);
};

test('identity leaves a point untouched', () => {
  nearPoint(applyToPoint(IDENTITY, { x: 3, y: -7 }), 3, -7);
});

test('translate offsets a point', () => {
  nearPoint(applyToPoint(translate(10, -5), { x: 1, y: 1 }), 11, -4);
});

test('scale multiplies each axis independently', () => {
  nearPoint(applyToPoint(scale(2, 3), { x: 4, y: 5 }), 8, 15);
});

test('rotate turns counter-clockwise', () => {
  nearPoint(applyToPoint(rotate(Math.PI / 2), { x: 1, y: 0 }), 0, 1);
  nearPoint(applyToPoint(rotate(Math.PI), { x: 1, y: 0 }), -1, 0);
});

test('multiply applies the inner transform first', () => {
  // Scale the point, then move it — (1,1) → (2,2) → (12,2)
  const m = multiply(translate(10, 0), scale(2, 2));
  nearPoint(applyToPoint(m, { x: 1, y: 1 }), 12, 2);
});

test('multiply is not commutative — swapping the order moves the point elsewhere', () => {
  // Move the point, then scale — (1,1) → (11,1) → (22,2)
  const m = multiply(scale(2, 2), translate(10, 0));
  nearPoint(applyToPoint(m, { x: 1, y: 1 }), 22, 2);
});

test('nested transforms compose the same way as applying them one at a time', () => {
  const inner = translate(5, 5);
  const outer = rotate(Math.PI / 2);
  const combined = multiply(outer, inner);

  const stepwise = applyToPoint(outer, applyToPoint(inner, { x: 1, y: 2 }));
  const atOnce = applyToPoint(combined, { x: 1, y: 2 });

  nearPoint(atOnce, stepwise.x, stepwise.y);
});

test('isSimilarity accepts rotations, uniform scales and mirrors', () => {
  assert.equal(isSimilarity(IDENTITY), true);
  assert.equal(isSimilarity(rotate(0.7)), true);
  assert.equal(isSimilarity(scale(3, 3)), true);
  assert.equal(isSimilarity(scale(-1, 1)), true, 'a mirror still maps circles to circles');
  assert.equal(isSimilarity(multiply(rotate(0.3), scale(2, 2))), true);
});

test('isSimilarity rejects non-uniform scale — that turns circles into ellipses', () => {
  assert.equal(isSimilarity(scale(2, 3)), false);
  assert.equal(isSimilarity(multiply(rotate(0.3), scale(2, 5))), false);
});

test('similarityScale reports the uniform scale factor', () => {
  near(similarityScale(scale(3, 3)), 3);
  near(similarityScale(rotate(1.2)), 1, 1e-12);
  near(similarityScale(multiply(rotate(0.4), scale(2.5, 2.5))), 2.5);
});

test('rotationAngle recovers the angle a rotation was built from', () => {
  near(rotationAngle(rotate(Math.PI / 4)), Math.PI / 4);
  near(rotationAngle(rotate(-1.1)), -1.1);
});

test('determinant is negative exactly when the transform mirrors', () => {
  near(determinant(scale(2, 3)), 6);
  assert.ok(determinant(scale(-1, 1)) < 0, 'mirrored transforms must report a negative determinant');
  assert.ok(determinant(rotate(2.2)) > 0);
});
