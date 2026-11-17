// The calendar day for the person, taken from their browser when it is within a day of the server's date.
export function getLocalToday(clientDay, serverDate = new Date()) {
  const server = serverDate.toISOString().slice(0, 10);
  if (typeof clientDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(clientDay)) {
    const offset = Math.abs(Date.parse(`${clientDay}T00:00:00Z`) - Date.parse(`${server}T00:00:00Z`));
    if (offset <= 86_400_000) return clientDay;
  }
  return server;
}