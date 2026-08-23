import { createExplorer, type TraceCtx } from '../dist/index';

export const explorer = createExplorer({
  basePath: '/__explorer',
  max: 200,
});

export type Env = {
  Variables: {
    trace: TraceCtx;
    userId?: string;
  };
};
