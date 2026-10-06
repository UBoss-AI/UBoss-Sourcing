/**
 * A console write, with its idempotency key held for exactly one intent.
 *
 * Every write in the console sends an `Idempotency-Key`. The key is created
 * when the screen first offers the action and kept until that action
 * SUCCEEDS: a retry after a lost response, a double press, a flaky site
 * connection on an inspector's phone - all replay the first answer instead
 * of recording a defect twice. After a success the next press is a new
 * intent and gets a new key.
 *
 * On success the listed queries are refreshed, and an optional toast says
 * what happened. Failures are left to the caller to show beside the form
 * (`MutationError`), where the reader is looking.
 */
import { useRef } from 'react';
import { useMutation, useQueryClient, type QueryKey, type UseMutationResult } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { consoleKeys, newIdempotencyKey } from './console-api';

export function useConsoleMutation<TVariables = void, TResult = unknown>(options: {
  mutationFn: (variables: TVariables, idempotencyKey: string) => Promise<TResult>;
  /** Queries to refresh after a success. The console dashboard is always refreshed too. */
  invalidate?: readonly QueryKey[];
  successMessage?: string | ((result: TResult, variables: TVariables) => string);
  onSuccess?: (result: TResult, variables: TVariables) => void;
}): UseMutationResult<TResult, unknown, TVariables> {
  const queryClient = useQueryClient();
  const toast = useToast();
  const key = useRef<string | null>(null);

  return useMutation<TResult, unknown, TVariables>({
    mutationFn: (variables) => {
      key.current ??= newIdempotencyKey();
      return options.mutationFn(variables, key.current);
    },
    onSuccess: async (result, variables) => {
      key.current = null;
      if (options.successMessage !== undefined) {
        toast.success(
          typeof options.successMessage === 'string' ? options.successMessage : options.successMessage(result, variables),
        );
      }
      options.onSuccess?.(result, variables);
      await Promise.all([
        ...(options.invalidate ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        queryClient.invalidateQueries({ queryKey: consoleKeys.dashboard() }),
      ]);
    },
  });
}
