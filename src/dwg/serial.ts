/**
 * Runs async jobs one at a time, in the order they were queued.
 *
 * The drawing worker receives jobs as messages, and an async message handler
 * would start every one of them at once: a DWG awaiting its converter lets the
 * next job start, and if that one blocks the thread the first never finishes.
 * One at a time, a job's first progress message means it really started — the
 * moment the host starts its clock.
 */
export function serialQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const next = last.then(job, job);
    // The chain must survive a job that fails; the caller still sees the failure.
    last = next.catch(() => {});
    return next;
  };
}
