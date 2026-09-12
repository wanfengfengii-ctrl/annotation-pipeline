// A new user intent invalidates earlier responses immediately, before React
// commits the next effect. Polling must never prevent the latest request.
export function latestRequest() {
  let revision = 0;
  return {
    begin() {
      const id = ++revision;
      return () => id === revision;
    },
    invalidate() {
      revision++;
    },
  };
}
