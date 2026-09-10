/**
 * Public front-end configuration.
 *
 * Both values below are safe to commit: a Google client ID and a Worker URL
 * are public by design. Nothing secret belongs in this file, or anywhere else
 * in web/ — everything here ships to the browser.
 */
window.RSVP_CONFIG = {
  // Google Cloud console -> Credentials -> OAuth 2.0 Client ID (Web application)
  GOOGLE_CLIENT_ID: "",

  // Your deployed Worker, e.g. https://rsvp-points-worker.<subdomain>.workers.dev
  WORKER_URL: "",
};
