/**
 * Public front-end configuration.
 *
 * Both values below are safe to commit: a Google client ID and a Worker URL
 * are public by design. Nothing secret belongs in this file, or anywhere else
 * in web/ — everything here ships to the browser.
 */
window.RSVP_CONFIG = {
  // Google Cloud console -> Credentials -> OAuth 2.0 Client ID (Web application)
  GOOGLE_CLIENT_ID: "32532424958-umer4n322a63nphfbnl0gkcqtrq92ms8.apps.googleusercontent.com",

  // The deployed Worker. For local development against `wrangler dev`,
  // change this to http://localhost:8787 and add that origin to the Worker's
  // ALLOWED_ORIGINS.
  WORKER_URL: "https://rsvp-points-worker.pc937.workers.dev",
};
