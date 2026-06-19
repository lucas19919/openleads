// Load variables from .env into process.env before anything reads them.
// Uses Node's built-in loader (Node 20.12+) — no dotenv dependency.
try {
  process.loadEnvFile()
} catch {
  // No .env file present — fall back to the real process environment.
}
