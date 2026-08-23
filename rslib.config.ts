import { defineConfig } from '@rslib/core';

export default defineConfig({
  source: {
    include: ['src/index.ts'],
  },
  lib: [
    {
      syntax: ['node 22'],
      dts: {
        bundle: true,
      },
    },
  ],
});
