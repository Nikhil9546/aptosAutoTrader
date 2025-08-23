/**
 * Signal ingestor stub.
 * Replace with real connectors; for now it just logs a tick every 10s.
 */
console.log('[ingestor] starting stub…');
setInterval(() => console.log('[ingestor] tick – would fetch/generate signals'), 10_000);
