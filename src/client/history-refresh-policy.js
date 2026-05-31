export function shouldRefreshHistoryOnStatus(status) {
  return status?.state === 'connected';
}
