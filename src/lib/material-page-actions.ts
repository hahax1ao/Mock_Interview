export async function keepSuccessfulDeletionNotice(
  successNotice: string,
  refresh: () => Promise<void>,
  setNotice: (notice: string) => void,
) {
  setNotice(successNotice);
  try {
    await refresh();
  } catch {
    // The completed deletion remains authoritative when only the follow-up refresh fails.
  }
}
