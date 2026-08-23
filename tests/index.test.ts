import { expect, test } from '@rstest/core';
import { createExplorer } from '../src/index.js';

test('createExplorer', () => {
  const explorer = createExplorer();
  expect(explorer).toBeDefined();
  expect(typeof explorer.tracer).toBe('function');
  expect(typeof explorer.ui).toBe('function');
});
