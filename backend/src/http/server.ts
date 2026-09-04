/**
 * API entrypoint.
 *
 * Shutdown is graceful on purpose: an in-flight checkout or webhook must finish
 * committing before the process exits, otherwise a customer is charged by the
 * provider while the order row never reaches CONFIRMED.
 */
import { env } from '../config/env.js';
import { logger } from '../infra/logger.js';
import { disconnectPrisma } from '../infra/prisma.js';
import { queue } from '../infra/queue/index.js';
import { assertCurrencyTableMatchesMoneyModule } from '../modules/settings/currency.service.js';
import { buildApp } from './app.js';
import { warmAssistant } from '../modules/assistant/assistant.service.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  // The currency table and domain/money.ts state the same exponents
  // independently. A disagreement mis-scales every amount in that currency by a
  // factor of ten or a hundred, so it is a refuse-to-start condition in the
  // same spirit as the live-Razorpay-key guard.
  await assertCurrencyTableMatchesMoneyModule();

  const app = await buildApp();

  await app.listen({ port: env.API_PORT, host: env.API_HOST });

  logger.info(
    {
      port: env.API_PORT,
      host: env.API_HOST,
      env: env.NODE_ENV,
      queueDriver: env.QUEUE_DRIVER,
      storageDriver: env.STORAGE_DRIVER,
      emailDriver: env.EMAIL_DRIVER,
    },
    'UBOSS API listening',
  );

  // Builds the assistant's catalogue snapshot once, after the port is open, so
  // the first visitor to open the chat panel does not wait for it. Awaited but
  // never fatal — see warmAssistant.
  await warmAssistant();

  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutting down');

    // Hard ceiling. If a request is wedged, exiting non-zero is better than
    // hanging forever and blocking a deploy.
    const timer = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    void (async () => {
      try {
        await app.close();
        await queue.shutdown();
        await disconnectPrisma();
        clearTimeout(timer);
        logger.info('shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, 'error during shutdown');
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // An unhandled rejection has left some invariant half-applied. Log loudly and
  // let the orchestrator restart into a known state rather than limping on.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'failed to start API');
  process.exit(1);
});
