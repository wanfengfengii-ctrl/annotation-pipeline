// Shared with CUA: keep this module free of CLI, environment and ledger setup.
export function uploadAllowed(now = new Date()) {
  const hour = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return Number(hour) >= 8;
}

export function assertUploadWindow(now = new Date()) {
  if (!uploadAllowed(now)) {
    const error = new Error('UPLOAD_PAUSED_UNTIL_08_SHANGHAI');
    error.code = error.message;
    throw error;
  }
}
