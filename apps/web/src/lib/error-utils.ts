export function getErrorMessage(error: unknown, fallback = 'Unexpected error'): string {
  if (error instanceof Error) {
    return error.message
  }

  return fallback
}
