/**
 * Run a write transaction again when the database reports a write conflict or
 * a deadlock (Prisma P2034).
 *
 * InnoDB resolves two transactions locking the same rows in opposite orders
 * by rolling one of them back. That is not an error the person caused: the
 * rolled-back attempt left nothing behind, and running it again - now that
 * the other one has committed - reads the new state and either succeeds or is
 * refused for a real reason ("already decided"), which is the answer the
 * person should get instead of a 500.
 *
 * Only for a transaction that is safe to repeat from the start: every read
 * inside it must happen inside it.
 */
export async function withWriteConflictRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2034' || attempt >= attempts) throw error;
      // A short, growing pause so the two do not collide again at once.
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
    }
  }
}
