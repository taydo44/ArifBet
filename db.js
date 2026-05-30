require("dotenv").config();
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, "piasa_online.db");

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Error opening database", err.message);
  } else {
    console.log("Connected to SQLite database:", dbPath);
    initializeDB();
  }
});

function initializeDB() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE,
      username TEXT,
      balance INTEGER DEFAULT 0,
      bonus INTEGER DEFAULT 0,
      played_games INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_ref TEXT,
      userID TEXT,
      amount INTEGER,
      status TEXT DEFAULT 'pending',
      method TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS game_numbers (
      id TEXT PRIMARY KEY,
      winner TEXT,
      win_amount INTEGER,
      player_count INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  });
}

module.exports = db;
