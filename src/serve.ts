import { startServer } from './boot.ts';

// Container entry point. No dotfile loading: every value comes from the
// environment, and Cloud Run injects PORT and requires 0.0.0.0.
console.log(
  await startServer({
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 8080),
  }),
);
