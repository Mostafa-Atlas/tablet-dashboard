const originalFetch = global.fetch;
global.fetch = (input, options) => {
  const url = new URL(input);
  if (url.hostname === '127.0.0.1' && url.pathname.endsWith('.ics')) return originalFetch(input, options);
  return Promise.reject(new Error('External network disabled by test fixture'));
};
