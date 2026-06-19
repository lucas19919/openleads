// Load .env into process.env before anything reads it (Node built-in loader).
try {
  process.loadEnvFile()
} catch {
  // No .env — rely on the real environment.
}
