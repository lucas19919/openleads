// Usage: npm run seed -- <username> <password>
// Creates the user if it doesn't exist, otherwise updates the password.
import { db } from '../src/db'
import { hashPassword } from '../src/auth'

const [, , username, password] = process.argv
if (!username || !password) {
  console.error('Usage: npm run seed -- <username> <password>')
  process.exit(1)
}

const hash = hashPassword(password)
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
if (existing) {
  db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username)
  console.log(`Updated password for "${username}".`)
} else {
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash)
  console.log(`Created user "${username}".`)
}
