/** Executor descriptions own the reserved transport in DSH 0.2.2. */
export const usesNativeTools = (ctx, agent) => !ctx.tools.selectExecutor(agent).describe([]).schemas.some(tool => tool.name === 'run_code');
